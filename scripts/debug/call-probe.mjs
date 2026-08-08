#!/usr/bin/env node
/**
 * call-probe.mjs — self-contained live probe of the call brain path.
 *
 * Plain Node, no new deps (fs + global fetch only, both stdlib in Node 18+).
 * Run: node scripts/debug/call-probe.mjs   (deck must already be up on :3000)
 *
 * What it measures, PASS/FAIL/UNVERIFIED per the division contract — every
 * number below is a captured command output, not an inference:
 *   1. POST /api/realtime        — 200, client_secret present, callBrain value
 *   2. POST /api/chat callVoice  — 200, first-byte + total ms, first 120 chars
 *   3. same call repeated twice  — is the 2nd call faster? cache-ish headers?
 *   4. data/memory.json stat     — byte-size + mtime before/after (READ-ONLY,
 *                                  this script never writes that file)
 *
 * Request shapes are taken from source, not guessed:
 *   - src/app/api/realtime/route.ts:76-146  → POST, no body, JSON out with
 *     {mode, value, expires_at, model, voice, url, callBrain}.
 *   - src/app/api/chat/route.ts:820-845     → POST JSON body
 *     {messages:[{role,content}], callVoice?: boolean, agentTools?: boolean},
 *     SSE response: `data: {"text": "..."}\n\n` frames, terminated by
 *     `data: [DONE]\n\n` (route.ts:63-65, 1191, 1197-1198).
 *   - src/middleware.ts:53-77 gates everything except /login, /api/auth,
 *     /starra-ca.crt, /api/mcp, /api/voice-tools behind the starra_auth
 *     cookie (src/lib/auth.ts). This probe logs in via POST /api/auth with
 *     STARRA_PASSWORD (read from .env.local, never hardcoded, never printed)
 *     exactly like the real login screen does, then carries that cookie on
 *     every subsequent request.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const BASE = process.env.PROBE_BASE || "http://localhost:3000";
const TIMEOUT_MS = 20_000;
const MEMORY_PATH = join(REPO, "data", "memory.json");
const PROBE_LINE = "One-line status check: are you online?";

// ── tiny .env.local reader — no dotenv dependency ──────────────────────────
function readEnvLocal() {
  const out = {};
  let text;
  try {
    text = readFileSync(join(REPO, ".env.local"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function timeoutSignal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/** Extract just the cookie NAME=VALUE pair from a Set-Cookie header. */
function parseCookiePair(setCookieHeader) {
  if (!setCookieHeader) return null;
  // Node/undici may join multiple Set-Cookie headers with ", " — the auth
  // route only ever sets one (src/app/api/auth/route.ts:80-90), so the first
  // `;`-delimited segment of the whole header value is the pair we want.
  return setCookieHeader.split(";")[0];
}

async function login() {
  const env = readEnvLocal();
  const password = env.STARRA_PASSWORD;
  if (!password) {
    throw new Error(
      "STARRA_PASSWORD not found in .env.local — cannot authenticate against the middleware gate (src/middleware.ts:53-77).",
    );
  }
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: timeoutSignal(),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `login POST /api/auth -> HTTP ${res.status}. Body: ${bodyText}`,
    );
  }
  const cookie = parseCookiePair(res.headers.get("set-cookie"));
  if (!cookie) {
    throw new Error(
      `login returned 200 but no Set-Cookie header — cannot carry a session. Body: ${bodyText}`,
    );
  }
  return cookie;
}

// ── result table plumbing ───────────────────────────────────────────────────
const results = [];
function record(id, label, status, detail) {
  results.push({ id, label, status, detail });
}

function printTable() {
  console.log("\n=== call-probe results ===\n");
  const w = Math.max(...results.map((r) => r.label.length)) + 2;
  for (const r of results) {
    console.log(`[${r.status.padEnd(11)}] ${r.label.padEnd(w)} ${r.detail}`);
  }
  console.log("");
}

// ── probe 1: POST /api/realtime ─────────────────────────────────────────────
async function probeRealtime(cookie) {
  const label = "1. POST /api/realtime";
  try {
    const res = await fetch(`${BASE}/api/realtime`, {
      method: "POST",
      headers: { Cookie: cookie },
      signal: timeoutSignal(),
    });
    const text = await res.text();
    if (!res.ok) {
      record(1, label, "FAIL", `HTTP ${res.status}. Body verbatim: ${text}`);
      return null;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      record(1, label, "FAIL", `200 but body is not JSON: ${text.slice(0, 200)}`);
      return null;
    }
    const hasSecret = json.mode === "live" && typeof json.value === "string" && json.value.length > 0;
    if (!hasSecret) {
      // Not a network failure — the route itself reports mode:"stub"/"error"
      // when the xAI key is missing or upstream failed (route.ts:80-85, 97-126).
      record(
        1,
        label,
        "FAIL",
        `200 but no live client_secret. mode=${json.mode} message=${json.message ?? "(none)"}`,
      );
      return json;
    }
    record(
      1,
      label,
      "PASS",
      `200, client_secret present (len ${json.value.length}), callBrain="${json.callBrain}", model=${json.model}`,
    );
    return json;
  } catch (err) {
    record(1, label, "FAIL", `request threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── probe 2/3 helper: one POST /api/chat callVoice:true call ──────────────
async function chatCallVoiceOnce(cookie, messages) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ messages, callVoice: true }),
    signal: timeoutSignal(),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return { ok: false, status: res.status, bodyText, headers: res.headers };
  }
  if (!res.body) {
    return { ok: false, status: res.status, bodyText: "(no response body / stream)", headers: res.headers };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let firstByteMs = null;
  let sawDone = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === null) firstByteMs = performance.now() - t0;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          continue;
        }
        try {
          const evt = JSON.parse(payload);
          if (typeof evt.text === "string") full += evt.text;
        } catch {
          /* non-JSON data frame — ignore, not a text chunk */
        }
      }
      idx = buf.indexOf("\n\n");
    }
  }
  const totalMs = performance.now() - t0;

  return {
    ok: true,
    status: res.status,
    firstByteMs,
    totalMs,
    text: full,
    sawDone,
    headers: res.headers,
  };
}

// ── probe 2: single callVoice call, latency + reply ─────────────────────────
async function probeChatOnce(cookie) {
  const label = "2. POST /api/chat callVoice:true";
  try {
    const r = await chatCallVoiceOnce(cookie, [{ role: "user", content: PROBE_LINE }]);
    if (!r.ok) {
      record(2, label, "FAIL", `HTTP ${r.status}. Body verbatim: ${r.bodyText}`);
      return null;
    }
    if (!r.text.trim()) {
      record(
        2,
        label,
        "FAIL",
        `200 and stream closed (done=${r.sawDone}) but reply text was empty — first-byte ${fmtMs(r.firstByteMs)}, total ${fmtMs(r.totalMs)}`,
      );
      return r;
    }
    record(
      2,
      label,
      "PASS",
      `200, first-byte ${fmtMs(r.firstByteMs)}, total ${fmtMs(r.totalMs)}, reply[0:120]="${r.text.slice(0, 120)}"`,
    );
    return r;
  } catch (err) {
    record(2, label, "FAIL", `request threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function fmtMs(n) {
  return n === null || n === undefined ? "n/a" : `${n.toFixed(0)}ms`;
}

function headerDump(headers) {
  // Every header the client actually receives — printed verbatim so "no
  // cache-related header exists" is a captured fact, not an assumption.
  const rel = [];
  for (const [k, v] of headers.entries()) {
    if (/cache|conv|grok|x-/i.test(k)) rel.push(`${k}: ${v}`);
  }
  return rel.length ? rel.join(" | ") : "(no cache/conv/x- headers on this response)";
}

// ── probe 3: repeat the SAME conversation twice, compare latency ───────────
async function probeChatCacheRepeat(cookie) {
  const label = "3. repeat callVoice call x2 (cache path)";
  // SAME conversation on purpose: identical single-turn message array both
  // times. Note the real cache key xAI keys on is x-grok-conv-id, and that
  // header is a FIXED SERVER CONSTANT the client cannot influence
  // (GROK_CONV_ID_DEFAULT="starra-stargate", src/lib/llm/hosted.ts:64,261) —
  // every /api/chat call on this deck, from any client, shares one cache
  // lane. So this probe's "same conversation" is the message content; the
  // cache lane itself is already shared across ALL calls in this run,
  // including probe 2 above.
  const messages = [{ role: "user", content: PROBE_LINE }];
  try {
    const first = await chatCallVoiceOnce(cookie, messages);
    const second = await chatCallVoiceOnce(cookie, messages);

    if (!first.ok || !second.ok) {
      record(
        3,
        label,
        "FAIL",
        `call1 HTTP ${first.status}${first.ok ? "" : ` body: ${first.bodyText}`} / call2 HTTP ${second.status}${second.ok ? "" : ` body: ${second.bodyText}`}`,
      );
      return { first, second };
    }

    const faster = second.totalMs < first.totalMs ? "2nd call FASTER" : "2nd call NOT faster";
    record(
      3,
      label,
      "PASS",
      `call1 total ${fmtMs(first.totalMs)} (first-byte ${fmtMs(first.firstByteMs)}) / call2 total ${fmtMs(second.totalMs)} (first-byte ${fmtMs(second.firstByteMs)}) — ${faster}. ` +
        `call1 headers: ${headerDump(first.headers)}. call2 headers: ${headerDump(second.headers)}.`,
    );
    return { first, second };
  } catch (err) {
    record(3, label, "FAIL", `request threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── probe 4: data/memory.json byte-size + mtime, READ-ONLY ─────────────────
function statMemory() {
  try {
    const st = statSync(MEMORY_PATH);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch (err) {
    return { exists: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function reportMemoryDiff(before, after) {
  const label = "4. data/memory.json stat before/after";
  if (!before.exists || !after.exists) {
    record(
      4,
      label,
      "UNVERIFIED",
      `before.exists=${before.exists} after.exists=${after.exists} — ${before.error ?? ""}${after.error ?? ""}`,
    );
    return;
  }
  const changed = before.size !== after.size || before.mtime !== after.mtime;
  // Expected result, per source: callVoice:true turns skip recordExchange
  // (src/app/api/chat/route.ts:942-943, "if (!callVoice) { await
  // recordExchange(...) }") because the call client records its own turns via
  // /api/memory instead (see the comment on the `callVoice` body field,
  // route.ts:827-834). All chat calls this probe made used callVoice:true, so
  // the FILE NOT CHANGING is the PASS condition here, not a null result.
  if (!changed) {
    record(
      4,
      label,
      "PASS",
      `unchanged across the probed turns (size ${before.size}->${after.size}, mtime ${before.mtime}->${after.mtime}) — expected: callVoice:true suppresses recordExchange, route.ts:942-943`,
    );
  } else {
    record(
      4,
      label,
      "FAIL",
      `CHANGED despite every probed turn using callVoice:true (size ${before.size}->${after.size}, mtime ${before.mtime}->${after.mtime}) — contradicts route.ts:942-943, investigate before trusting the call-turn memory-isolation claim`,
    );
  }
}

async function main() {
  console.log(`call-probe.mjs — target ${BASE}, timeout ${TIMEOUT_MS}ms/request`);

  let cookie;
  try {
    cookie = await login();
    console.log("login: OK (session cookie acquired via POST /api/auth)");
  } catch (err) {
    console.error(
      `BLOCKER — cannot authenticate: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "Every probe below is UNVERIFIED as a direct consequence — none can run without a session cookie.",
    );
    for (const [id, label] of [
      [1, "1. POST /api/realtime"],
      [2, "2. POST /api/chat callVoice:true"],
      [3, "3. repeat callVoice call x2 (cache path)"],
      [4, "4. data/memory.json stat before/after"],
    ]) {
      record(id, label, "UNVERIFIED", "blocked — no session cookie, see BLOCKER above");
    }
    printTable();
    process.exitCode = 1;
    return;
  }

  await probeRealtime(cookie);

  const before = statMemory();
  await probeChatOnce(cookie);
  await probeChatCacheRepeat(cookie);
  const after = statMemory();
  reportMemoryDiff(before, after);

  printTable();
}

main().catch((err) => {
  console.error("UNCAUGHT — probe crashed:", err);
  process.exitCode = 1;
});
