/**
 * PRIVATE CALL — the all-local call engine (P2 Task 4).
 *
 * PRIVACY IS THE SPEC here, so these are split deliberately into two kinds and
 * labelled as such (the pin-honesty standard this project set in P2 Task 3):
 *
 *   BEHAVIOURAL  — the real exported function is called and its output
 *                  asserted. Every decision the engine makes about a turn
 *                  (framing, the private marker, the endpointer, barge-in, the
 *                  WAV container, the prefix, the status copy) is one of these.
 *   SOURCE-PATTERN — an assertion about the FILE, used only where the property
 *                  is "this code path does not exist", which no amount of
 *                  calling a function can prove. The absence of a hosted socket
 *                  is exactly that kind of claim.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PRIVATE_BARGE_FRAMES,
  PRIVATE_CHAT_PATH,
  PRIVATE_MAX_UTTERANCE_SAMPLES,
  PRIVATE_MIN_UTTERANCE_SAMPLES,
  PRIVATE_PREROLL_FRAMES,
  PRIVATE_REPLY_EMPTY,
  PRIVATE_SLOW_BUDGET_MS,
  PRIVATE_SLOW_NOTICE,
  PRIVATE_TRANSCRIBE_PATH,
  PRIVATE_TURN_PREFIX,
  WHISPER_SAMPLE_RATE,
  callEngineNote,
  privateAskBody,
  privateBargeStep,
  privateReplyStep,
  privateSlowNotice,
  privateStatusCopy,
  takeSsePayloads,
  toCallFaceState,
  wavBytesFromFrames,
  type PrivateCallState,
} from "@/lib/voice/usePrivateCall";
import {
  KIMI_ENDPOINTER_IDLE,
  KIMI_ENDPOINT_MIN_SPEECH_FRAMES,
  KIMI_ENDPOINT_SILENCE_FRAMES,
  kimiEndpointStep,
} from "@/lib/voice/useVoiceCall";
import { parsePrivateCommand } from "@/lib/private/commands";

const ROOT = join(__dirname, "..");
const HOOK_PATH = join(ROOT, "src/lib/voice/usePrivateCall.ts");
const ROUTE_PATH = join(ROOT, "src/app/api/private-call/transcribe/route.ts");
const HOOK_SRC = readFileSync(HOOK_PATH, "utf8");
const ROUTE_SRC = readFileSync(ROUTE_PATH, "utf8");

// ── SOURCE-PATTERN: the code paths that must not exist ─────────────────────

describe("private call — SOURCE-PATTERN: no hosted leg exists in this engine", () => {
  // Built from character codes so this test file's own source cannot be what a
  // future grep for these tokens finds — and so the assertion is about the
  // engine, not about a string that happens to sit next to it here.
  const hostedApiHost = ["api", ".", "x", ".", "a", "i"].join("");
  const hostedVendor = ["x", "a", "i"].join("");
  const socketScheme = ["w", "s", "s", ":"].join("");
  const hostedTtsRoute = ["/api", "/tts"].join("");
  const browserSpeechApi = ["Speech", "Recognition"].join("");

  it("names no hosted voice host", () => {
    assert.ok(
      !HOOK_SRC.includes(hostedApiHost),
      "usePrivateCall must not reference the hosted realtime host",
    );
    assert.ok(
      !HOOK_SRC.toLowerCase().includes(hostedVendor),
      "usePrivateCall must not reference the hosted voice vendor at all",
    );
  });

  it("opens no socket", () => {
    assert.ok(!HOOK_SRC.includes(socketScheme));
    assert.ok(!/\bnew WebSocket\b/.test(HOOK_SRC));
  });

  it("never reaches the hosted TTS route", () => {
    assert.ok(!HOOK_SRC.includes(hostedTtsRoute));
  });

  it("never falls back to the browser's own speech engine", () => {
    assert.ok(!HOOK_SRC.includes(browserSpeechApi));
  });

  it("fetches exactly two endpoints, both same-origin deck routes", () => {
    // Every fetch target in the file, as written.
    const targets = [...HOOK_SRC.matchAll(/fetch\(\s*([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      [...new Set(targets)].sort(),
      ["PRIVATE_CHAT_PATH", "PRIVATE_TRANSCRIBE_PATH"],
      "the private engine may fetch nothing but its own two deck routes",
    );
    // …and those two constants are relative paths, so they cannot name a host.
    assert.equal(PRIVATE_TRANSCRIBE_PATH, "/api/private-call/transcribe");
    assert.equal(PRIVATE_CHAT_PATH, "/api/chat");
    for (const p of [PRIVATE_TRANSCRIBE_PATH, PRIVATE_CHAT_PATH]) {
      assert.ok(p.startsWith("/"), `${p} must be same-origin`);
      assert.ok(!p.includes("//"), `${p} must not be protocol-relative`);
    }
  });

  it("reuses the endpointer instead of forking it", () => {
    assert.match(
      HOOK_SRC,
      /import\s*\{[^}]*kimiEndpointStep[^}]*\}\s*from\s*"@\/lib\/voice\/useVoiceCall"/,
      "the endpointer must be imported from useVoiceCall, not re-implemented",
    );
    assert.ok(
      !/function\s+kimiEndpointStep/.test(HOOK_SRC),
      "usePrivateCall must not define its own copy of the endpointer",
    );
  });
});

describe("private call — SOURCE-PATTERN: the transcribe route's one host", () => {
  it("guards the base with the private lane's own loopback predicate", () => {
    assert.match(
      ROUTE_SRC,
      /import\s*\{\s*isLoopbackBase\s*\}\s*from\s*"@\/app\/api\/chat\/route"/,
      "the loopback rule must be the private lane's, imported — never a second copy",
    );
    assert.match(ROUTE_SRC, /if\s*\(!isLoopbackBase\(base\)\)/);
  });

  it("makes exactly one outbound request, to that guarded base", () => {
    const fetches = [...ROUTE_SRC.matchAll(/\bfetch\(/g)];
    assert.equal(fetches.length, 1, "one leg only — no fallback, no second try");
    assert.match(ROUTE_SRC, /fetch\(`\$\{base\}\/inference`/);
  });

  it("hardcodes a numeric loopback default, never a hostname", () => {
    assert.match(
      ROUTE_SRC,
      /WHISPER_FALLBACK_BASE\s*=\s*"http:\/\/127\.0\.0\.1:8178"/,
    );
    // "localhost" appears twice in the route — once in the refusal MESSAGE and
    // once in the comment explaining it. Neither is a URL, and that is the
    // property worth pinning: no host NAME is ever dialled, because a name is
    // something a hosts file can move off-box.
    assert.ok(
      !/https?:\/\/[a-z]/i.test(ROUTE_SRC.replace(/https?:\/\/127\.0\.0\.1/g, "")),
      "every URL in the route must be a numeric loopback address",
    );
  });
});

// ── BEHAVIOURAL: the endpointer, reused not forked ─────────────────────────

describe("private call — BEHAVIOURAL: endpointer reuse", () => {
  it("commits a real turn on exactly the shared thresholds", () => {
    let s = KIMI_ENDPOINTER_IDLE;
    let commits = 0;
    for (let i = 0; i < KIMI_ENDPOINT_MIN_SPEECH_FRAMES; i++) {
      const r = kimiEndpointStep(s, true);
      s = r.next;
      if (r.commit) commits++;
    }
    assert.equal(commits, 0, "sound alone never ends a turn");
    for (let i = 0; i < KIMI_ENDPOINT_SILENCE_FRAMES; i++) {
      const r = kimiEndpointStep(s, false);
      s = r.next;
      if (r.commit) commits++;
    }
    assert.equal(commits, 1, "one commit, at the end of the silence run");
    assert.deepEqual(s, KIMI_ENDPOINTER_IDLE);
  });

  it("drains a blip away without committing", () => {
    let s = KIMI_ENDPOINTER_IDLE;
    let commits = 0;
    for (let i = 0; i < KIMI_ENDPOINT_MIN_SPEECH_FRAMES - 1; i++) {
      s = kimiEndpointStep(s, true).next;
    }
    for (let i = 0; i < KIMI_ENDPOINT_SILENCE_FRAMES + 3; i++) {
      const r = kimiEndpointStep(s, false);
      s = r.next;
      if (r.commit) commits++;
    }
    assert.equal(commits, 0, "a cough is not a turn");
  });

  it("sizes its buffers against the SAME frame clock the endpointer counts in", () => {
    // ~43ms frames (2048 samples @ ~48kHz — public/pcm-worklet-processor.js:28).
    // The pre-roll must be shorter than the minimum speech run, or a turn would
    // start with audio the endpointer already decided was silence.
    assert.ok(PRIVATE_PREROLL_FRAMES <= KIMI_ENDPOINT_MIN_SPEECH_FRAMES);
    // The cap must be far above a normal utterance and equal to the route's.
    assert.equal(PRIVATE_MAX_UTTERANCE_SAMPLES, 30 * WHISPER_SAMPLE_RATE);
    assert.ok(PRIVATE_MIN_UTTERANCE_SAMPLES < PRIVATE_MAX_UTTERANCE_SAMPLES);
  });
});

// ── BEHAVIOURAL: barge-in ──────────────────────────────────────────────────

describe("private call — BEHAVIOURAL: barge-in", () => {
  it("fires after exactly PRIVATE_BARGE_FRAMES sustained loud frames", () => {
    let streak = 0;
    let fired = 0;
    for (let i = 0; i < PRIVATE_BARGE_FRAMES; i++) {
      const r = privateBargeStep(streak, true, false);
      streak = r.streak;
      if (r.barge) fired++;
    }
    assert.equal(fired, 1);
    assert.equal(streak, 0, "the streak resets so it cannot fire twice");
  });

  it("a lone spike never interrupts her", () => {
    let streak = 0;
    let fired = 0;
    for (let i = 0; i < PRIVATE_BARGE_FRAMES * 3; i++) {
      const loud = i % 2 === 0; // never two in a row
      const r = privateBargeStep(streak, loud, false);
      streak = r.streak;
      if (r.barge) fired++;
    }
    assert.equal(fired, 0);
  });

  it("nothing at all can interrupt inside the grace window", () => {
    let streak = 0;
    let fired = 0;
    for (let i = 0; i < PRIVATE_BARGE_FRAMES * 4; i++) {
      const r = privateBargeStep(streak, true, true);
      streak = r.streak;
      if (r.barge) fired++;
    }
    assert.equal(fired, 0, "her own onset and echo tail must not cut her off");
    assert.equal(streak, 0);
  });
});

// ── BEHAVIOURAL: the ask that reaches /api/chat ────────────────────────────

describe("private call — BEHAVIOURAL: the ask is always private", () => {
  it("prefixes the transcript so the route takes the private branch", () => {
    const body = privateAskBody("what is the code");
    assert.deepEqual(body, {
      messages: [{ role: "user", content: "private what is the code" }],
    });
  });

  it("what it builds is what the route's OWN parser routes locally", () => {
    // Not a lookalike assertion: the real gate is parsePrivateCommand, so the
    // body is handed to it. If the prefix ever drifted, this fails.
    for (const said of [
      "what is the code",
      "  padded  ",
      "multi\nline ask",
      "private things I keep",
    ]) {
      const content = privateAskBody(said).messages[0].content;
      const cmd = parsePrivateCommand(content);
      assert.notEqual(cmd, null, `"${said}" must route to the private lane`);
      assert.equal(cmd?.kind, "chat");
    }
  });

  it("sends exactly one turn — never deck history", () => {
    assert.equal(privateAskBody("x").messages.length, 1);
  });

  it("trims, so a trailing pause cannot produce a bare-prefix ask", () => {
    assert.equal(
      privateAskBody("  hello  ").messages[0].content,
      `${PRIVATE_TURN_PREFIX}hello`,
    );
  });
});

// ── BEHAVIOURAL: the reply, frame by frame ─────────────────────────────────

describe("private call — BEHAVIOURAL: SSE framing and the private marker", () => {
  const marker = 'data: {"private":true}\n\n';
  const text = (t: string) => `data: ${JSON.stringify({ text: t })}\n\n`;

  it("cuts complete frames and keeps the unfinished tail verbatim", () => {
    const cut = takeSsePayloads(`${marker}${text("hi")}data: {"text":"par`);
    assert.deepEqual(cut.payloads, ['{"private":true}', '{"text":"hi"}']);
    assert.equal(cut.rest, 'data: {"text":"par');
  });

  it("survives a payload split across two reads", () => {
    let buf = "";
    let acc = PRIVATE_REPLY_EMPTY;
    // Deliberately nasty chunking: mid-JSON, mid-separator.
    const wire = `${marker}${text("Copy. ")}${text("On it.")}data: [DONE]\n\n`;
    for (let i = 0; i < wire.length; i += 7) {
      buf += wire.slice(i, i + 7);
      const cut = takeSsePayloads(buf);
      buf = cut.rest;
      for (const p of cut.payloads) acc = privateReplyStep(acc, p);
    }
    assert.equal(acc.text, "Copy. On it.");
    assert.equal(acc.markedPrivate, true);
  });

  it("[DONE] and junk frames are inert", () => {
    let acc = PRIVATE_REPLY_EMPTY;
    for (const p of ["[DONE]", "", "not json", "[1,2]", "null", '{"text":""}']) {
      acc = privateReplyStep(acc, p);
    }
    assert.deepEqual(acc, PRIVATE_REPLY_EMPTY);
  });

  it("a reply with NO private marker is left unmarked — the caller refuses it", () => {
    let acc = PRIVATE_REPLY_EMPTY;
    for (const p of ['{"text":"hosted answer"}']) acc = privateReplyStep(acc, p);
    assert.equal(acc.markedPrivate, false, "unmarked = not from the private lane");
    assert.equal(acc.text, "hosted answer");
  });

  it("only a literal true is the marker", () => {
    let acc = PRIVATE_REPLY_EMPTY;
    acc = privateReplyStep(acc, '{"private":1}');
    acc = privateReplyStep(acc, '{"private":"true"}');
    assert.equal(acc.markedPrivate, false);
    acc = privateReplyStep(acc, '{"private":true}');
    assert.equal(acc.markedPrivate, true);
  });
});

// ── BEHAVIOURAL: the WAV the ears receive ──────────────────────────────────

describe("private call — BEHAVIOURAL: the 16 kHz mono WAV", () => {
  const u32 = (b: Uint8Array, at: number) =>
    b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);
  const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
  const ascii = (b: Uint8Array, at: number, n: number) =>
    String.fromCharCode(...b.subarray(at, at + n));

  it("writes the exact container whisper.cpp's reader requires", () => {
    const frames = [new Float32Array(1000), new Float32Array(1048)];
    const wav = wavBytesFromFrames(frames);
    assert.equal(ascii(wav, 0, 4), "RIFF");
    assert.equal(ascii(wav, 8, 4), "WAVE");
    assert.equal(u16(wav, 20), 1, "PCM");
    assert.equal(u16(wav, 22), 1, "mono — whisper.cpp reads one channel");
    assert.equal(u32(wav, 24), WHISPER_SAMPLE_RATE, "16 kHz, not the mic's rate");
    assert.equal(u16(wav, 34), 16, "16-bit");
    assert.equal(ascii(wav, 36, 4), "data");
    assert.equal(u32(wav, 40), 2048 * 2, "every sample, no padding, no loss");
    assert.equal(wav.length, 44 + 2048 * 2);
  });

  it("concatenates the frames in order, sample for sample", () => {
    const a = Float32Array.from([1, 0, -1]);
    const b = Float32Array.from([0.5, -0.5]);
    const wav = wavBytesFromFrames([a, b], WHISPER_SAMPLE_RATE);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const at = (i: number) => view.getInt16(44 + i * 2, true);
    assert.equal(at(0), 0x7fff);
    assert.equal(at(1), 0);
    assert.equal(at(2), -0x8000);
    assert.equal(at(3), Math.trunc(0.5 * 0x7fff));
    assert.equal(at(4), Math.trunc(-0.5 * 0x8000));
  });

  it("an empty turn produces a header-only WAV, never a throw", () => {
    const wav = wavBytesFromFrames([]);
    assert.equal(wav.length, 44);
    assert.equal(u32(wav, 40), 0);
  });
});

// ── BEHAVIOURAL: what the overlay shows ────────────────────────────────────

describe("private call — BEHAVIOURAL: status, face and the honest notice", () => {
  const ALL: PrivateCallState[] = [
    "idle",
    "connecting",
    "listening",
    "transcribing",
    "thinking",
    "speaking",
    "error",
  ];

  it("every state has operator copy — no emojis, no exclamation", () => {
    for (const s of ALL) {
      const copy = privateStatusCopy(s);
      assert.ok(copy.length > 0, `${s} has no copy`);
      assert.ok(!/[!]/.test(copy), `${s} copy is not operator voice`);
      // Anything outside the Basic Latin block would be an emoji or a symbol;
      // the ellipsis and the em dash are the two deliberate exceptions.
      const stripped = copy.replace(/[…—]/g, "");
      assert.ok(/^[\x20-\x7e]*$/.test(stripped), `${s} copy has stray glyphs`);
    }
  });

  it("only the speaking state animates her mouth", () => {
    for (const s of ALL) {
      const face = toCallFaceState(s);
      assert.equal(
        face === "speaking",
        s === "speaking",
        `${s} must not read as speaking on her face`,
      );
    }
  });

  it("the working states read as attentive listening, not as idle", () => {
    for (const s of ["listening", "transcribing", "thinking"] as PrivateCallState[]) {
      assert.equal(toCallFaceState(s), "listening");
    }
    assert.equal(toCallFaceState("idle"), "idle");
    assert.equal(toCallFaceState("error"), "error");
    assert.equal(toCallFaceState("connecting"), "connecting");
  });

  it("an UNMEASURED turn still warns that the lane is slower", () => {
    assert.equal(privateSlowNotice(null), PRIVATE_SLOW_NOTICE);
  });

  it("the warning goes away only for a turn measured under budget", () => {
    assert.equal(privateSlowNotice(PRIVATE_SLOW_BUDGET_MS - 1), null);
    assert.equal(privateSlowNotice(PRIVATE_SLOW_BUDGET_MS), null);
    assert.equal(privateSlowNotice(PRIVATE_SLOW_BUDGET_MS + 1), PRIVATE_SLOW_NOTICE);
  });

  it("a mid-call flip says it applies to the NEXT call", () => {
    assert.equal(
      callEngineNote({
        chosen: "private",
        active: "normal",
        callLive: true,
        lastTurnMs: null,
      }),
      "Applies to the next call.",
    );
  });

  it("the normal engine's surface gains no note at all", () => {
    assert.equal(
      callEngineNote({
        chosen: "normal",
        active: "normal",
        callLive: true,
        lastTurnMs: null,
      }),
      "",
    );
    assert.equal(
      callEngineNote({
        chosen: "normal",
        active: "normal",
        callLive: false,
        lastTurnMs: 900,
      }),
      "",
    );
  });

  it("a live private call carries the slow warning until it is beaten", () => {
    const live = { chosen: "private", active: "private", callLive: true } as const;
    assert.equal(callEngineNote({ ...live, lastTurnMs: null }), PRIVATE_SLOW_NOTICE);
    assert.equal(callEngineNote({ ...live, lastTurnMs: 9_000 }), PRIVATE_SLOW_NOTICE);
    assert.equal(
      callEngineNote({ ...live, lastTurnMs: 1_200 }),
      "PRIVATE — nothing leaves this Mac.",
    );
  });
});

// ── BEHAVIOURAL: the toggle's default ──────────────────────────────────────
//
// deck-prefs reads `window.localStorage` inside its functions (never at module
// evaluation), so the shim below only has to exist before the first call —
// exactly the arrangement tests/deck-prefs.test.ts documents.

const backing = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};

describe("private call — BEHAVIOURAL: the engine toggle defaults to NORMAL", () => {
  beforeEach(() => backing.clear());

  it("an operator who never touches it gets the hosted call", async () => {
    const { getCallEngine } = await import("@/lib/voice/deck-prefs");
    assert.equal(getCallEngine(), "normal");
  });

  it("round-trips the private choice", async () => {
    const { getCallEngine, setCallEngine } = await import("@/lib/voice/deck-prefs");
    setCallEngine("private");
    assert.equal(getCallEngine(), "private");
    setCallEngine("normal");
    assert.equal(getCallEngine(), "normal");
  });

  it("anything that is not exactly \"private\" falls back to NORMAL", async () => {
    const { getCallEngine } = await import("@/lib/voice/deck-prefs");
    for (const junk of ["", "PRIVATE", "priv", "1", "true", "{}", " private "]) {
      backing.set("stargate.callEngine", junk);
      assert.equal(getCallEngine(), "normal", `"${junk}" must not arm the lane`);
    }
  });
});

// ── SOURCE-PATTERN: the overlay routes to the chosen engine ────────────────

describe("private call — SOURCE-PATTERN: the overlay's wiring", () => {
  const OVERLAY_SRC = readFileSync(
    join(ROOT, "src/components/bridge/VoiceCallOverlay.tsx"),
    "utf8",
  );

  it("defaults its own engine state to normal, and reads the pref after mount", () => {
    assert.match(OVERLAY_SRC, /useState<CallEngine>\("normal"\)/);
    assert.match(OVERLAY_SRC, /setEngine\(getCallEngine\(\)\)/);
  });

  it("captures the engine at connect and dials that one", () => {
    assert.match(OVERLAY_SRC, /const chosen = engineRef\.current;/);
    assert.match(OVERLAY_SRC, /setActiveEngine\(chosen\)/);
    assert.match(
      OVERLAY_SRC,
      /chosen === "private"\s*\?*\s*\)?\s*void privConnectRef\.current\(\)/,
    );
  });

  it("hangs BOTH engines up on close, so a swap can never strand a live mic", () => {
    assert.match(OVERLAY_SRC, /hostedDisconnectRef\.current\(\);\s*privDisconnectRef\.current\(\);/);
  });

  it("a typed turn on a private call is prefixed BEFORE any hosted branch", () => {
    const privateBranch = OVERLAY_SRC.indexOf("if (isPrivate) {");
    const mcpBranch = OVERLAY_SRC.indexOf("if (parseMcpCommand(t))");
    const codeBranch = OVERLAY_SRC.indexOf("if (isCodeAsk(t))");
    const sendTextBranch = OVERLAY_SRC.indexOf("if (sendText(t)) return;");
    assert.ok(privateBranch > 0, "the private typed-turn branch must exist");
    for (const [name, at] of [
      ["mcp", mcpBranch],
      ["code", codeBranch],
      ["sendText", sendTextBranch],
    ] as const) {
      assert.ok(
        privateBranch < at,
        `the private branch must precede the ${name} branch — every one of those ends at the hosted brain`,
      );
    }
  });
});
