import {
  backupBrainNotice,
  buildOneStarraPrompt,
  buildSystemPromptBlocks,
  buildTieredSystemPrompt,
  type SystemPromptBlocks,
  KIMI_COMPLETION_RESERVE,
  KIMI_VOICE_COMPLETION_RESERVE,
  KIMI_VOICE_SYSTEM_TOKEN_BUDGET,
  KIMI_SYSTEM_TOKEN_BUDGET,
} from "@/lib/brain";
import { getTier1, serializeTier1 } from "@/lib/context/tier1";
import {
  getMemory,
  memoryForPrompt,
  recordExchange,
} from "@/lib/memory/store";
import { extractFactsFromExchange } from "@/lib/memory/extract";
import { getVault, vaultForPrompt } from "@/lib/vault/store";
import { obsidianForPrompt } from "@/lib/obsidian";
import { readLatestPackPreview } from "@/lib/tools/repomix";
import {
  webSearch,
  webSearchQuery,
  formatWebResults,
  weatherLocation,
  getWeather,
} from "@/lib/tools/websearch";
import { maybeToolReply } from "@/lib/tools/fastpath";
import { isLocalRequest } from "@/lib/auth-lockout";
import {
  parsePrivateCommand,
  type PrivateCommand,
} from "@/lib/private/commands";
// The egress gate. Shared with /api/private-call/transcribe — ONE definition of
// "is this address really on this machine", in a leaf module both routes can
// import cheaply (src/lib/private/loopback.ts).
import { isLoopbackBase } from "@/lib/private/loopback";
import {
  ollamaStatus,
  ollamaConfig,
  streamOllama,
  stripThinkTags,
} from "@/lib/llm/ollama";
import { streamHosted, hostedAvailable } from "@/lib/llm/hosted";
import { brainTier } from "@/lib/llm/spend";
import { zdrBlocksHostedLane, zdrState } from "@/lib/llm/zdr";
import { getKey } from "@/lib/keys";
import { addTokens } from "@/lib/metrics";
import { pushFeed } from "@/lib/feed";
import { fenceUntrusted } from "@/lib/security/fencing";
import { redact } from "@/lib/security/redact";
import { formatThreatBrief, scanContent } from "@/lib/security/team";
import {
  runAnthropicAgent,
  streamAnthropicCached,
} from "@/lib/agent/anthropic";
import { MAX_AGENT_TURNS } from "@/lib/agent/loop";

export const runtime = "nodejs";
export const maxDuration = 180;

type ChatMessage = { role: "user" | "assistant"; content: string };

function sse(text: string) {
  return `data: ${JSON.stringify({ text })}\n\n`;
}

/** Non-text control frame (the private marker). Same SSE envelope, no `text`. */
function sseFrame(obj: Record<string, unknown>) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Local 1.5B on 8GB: ~60–80ms/token. Cap ~2k chars so prompt eval stays HUD-viable. */
const LOCAL_SYSTEM_BUDGET = 1_800;

const LOCAL_VOICE_TAIL = `
VOICE (hard): You are STARRA — Classic's warm, high-agency partner. Confident,
direct, never cold. Do NOT open with "Copy." — answer as yourself.
Forbidden: replying with only an acknowledgement; repeating canned example lines —
answer Classic's actual question. Warmth welcome ("Classic", "partner"), never filler.
Lead with the next concrete move. Truth first, then the path through.
`.trim();

/** Lines the 1.5B regurgitates from prior prompt tails — treat as copy-loop. */
const FEWSHOT_ECHO_LINES = [
  "Copy. Next: status on LLM link, then queue the brief.",
  "Copy. Systems nominal. Standing by for the next order.",
  "Copy. Standing by — state the objective in one line and I execute.",
];

function isCopyOnly(text: string): boolean {
  return /^copy\.?\s*$/i.test(text.trim());
}

function isFewShotEcho(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return FEWSHOT_ECHO_LINES.some(
    (line) => t === line || t.startsWith(line) || t.includes(line),
  );
}

function needsCopyRetry(text: string): boolean {
  return isCopyOnly(text) || isFewShotEcho(text) || !text.trim();
}

/** Groq free tier caps a request at 8K tokens — clamp history alongside the
 * tiered system prompt so system+messages stays under the cap. Grok/Anthropic
 * have no such cap and keep the full, unclamped history. */
const KIMI_HISTORY_TURN_LIMIT = 6;
const KIMI_HISTORY_CHAR_BUDGET = 2_000;

function clampHistoryForKimi(msgs: ChatMessage[]): ChatMessage[] {
  const tail = msgs.slice(-KIMI_HISTORY_TURN_LIMIT);
  let budget = KIMI_HISTORY_CHAR_BUDGET;
  const out: ChatMessage[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    budget -= m.content.length;
    out.unshift(m);
    if (budget <= 0) break;
  }
  return out.length ? out : tail.slice(-1);
}

function clipSystemForLocal(system: string): string {
  const reserve = LOCAL_VOICE_TAIL.length + 24;
  const budget = Math.max(800, LOCAL_SYSTEM_BUDGET - reserve);
  if (system.length <= budget) {
    return `${system}\n\n${LOCAL_VOICE_TAIL}`;
  }
  // Keep head (structure/soul) + tail (brain/runtime) + hard voice rules
  const head = Math.floor(budget * 0.55);
  const tail = budget - head - 20;
  return `${system.slice(0, head)}\n…[truncated]…\n${system.slice(-tail)}\n\n${LOCAL_VOICE_TAIL}`;
}

/** Tiny local models latch onto repeated "Copy." — expand or drop those turns. */
function sanitizeMessagesForLocal(
  messages: { role: string; content: string }[],
): { role: "user" | "assistant"; content: string }[] {
  const stuck =
    messages.filter((m) => m.role === "assistant" && isCopyOnly(m.content))
      .length >= 1;
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.role === "assistant" && isCopyOnly(m.content)) {
      // Don't feed empty acknowledgements back into the context window
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  if (stuck && out.length > 0) {
    const last = out[out.length - 1];
    if (last?.role === "user") {
      last.content = `${last.content}\n\n(Answer fully. Do not reply with only "Copy.")`;
    }
  }
  return out.length ? out : [{ role: "user", content: "Status." }];
}

/**
 * Buffer local generation, then one forced retry if the model latches on "Copy."
 * Streams only the final text so the console never lands on a lone acknowledgement.
 */
async function streamLocalWithCopyGuard(opts: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  lastUser: string;
  onText: (t: string) => void;
}): Promise<{
  draft: string;
  retried: boolean;
  usedFallback: boolean;
  echoRetry: boolean;
}> {
  let draft = "";
  await streamOllama({
    system: opts.system,
    messages: opts.messages,
    onText: (t) => {
      draft += t;
    },
  });
  draft = stripThinkTags(draft);
  let retried = false;
  let echoRetry = false;
  if (needsCopyRetry(draft)) {
    retried = true;
    echoRetry = isFewShotEcho(draft);
    draft = "";
    const forceSystem = `${LOCAL_VOICE_TAIL}\nAnswer the operator now. Lead with the next concrete move. Do not reuse example lines. A reply that is only "Copy." is a failure.`;
    const forceMessages: { role: "user" | "assistant"; content: string }[] = [
      ...opts.messages,
      {
        role: "user",
        content: `${opts.lastUser || "Status."}\n\n(Required: fresh answer about their question. Not a canned line. Not only Copy.)`,
      },
    ];
    await streamOllama({
      system: forceSystem,
      messages: forceMessages,
      onText: (t) => {
        draft += t;
      },
    });
    draft = stripThinkTags(draft);
  }
  let usedFallback = false;
  if (needsCopyRetry(draft)) {
    usedFallback = true;
    const q = (opts.lastUser || "status").toLowerCase();
    draft = q.includes("brief")
      ? "On it, Classic — brief queued. First move is the LLM link check, then your orders."
      : q.includes("status")
        ? "Link's up, running local Ollama. I'm right here, Classic — what's the next move?"
        : `Heard you, Classic: ${(opts.lastUser || "status").slice(0, 48)}. Give me the objective and I run it.`;
  }
  for await (const chunk of stubStream(draft)) opts.onText(chunk);
  return { draft, retried, usedFallback, echoRetry };
}

/**
 * Typewriter replay for text that is ALREADY fully known — a fast-path tool
 * answer, a shell result, the offline notice, a finished agent run. These are
 * the replies that have nothing to wait for, so the only thing between Classic
 * and the words is this function's own sleep.
 *
 * It used to be 12ms per 12 characters: almost exactly 1ms of pure sleep per
 * character, so an 800-character tool answer that the server already held in a
 * variable took 800ms to hand over. Now 6ms per 32 characters — about 0.19ms
 * per character, a little over 5x faster — which still reads as her typing
 * rather than a block appearing, without charging a second for a reply that
 * cost nothing to produce.
 */
async function* stubStream(message: string) {
  const chunks = message.match(/.{1,32}/g) ?? [message];
  for (const c of chunks) {
    yield c;
    await new Promise((r) => setTimeout(r, 6));
  }
}

/**
 * Explicit operator shell path — works on ANY provider (Kimi/Grok/Ollama), no
 * LLM tool-calling required. Triggers: `run: <cmd>`, `exec: <cmd>`, `$ <cmd>`,
 * or `confirm <token>` (to approve a destructive command the gate held).
 * LOCALHOST ONLY — refuses when the deck is reached over the LAN/phone, so an
 * exposed deck can never be used to run commands remotely.
 */
async function maybeShellReply(
  lastUser: string,
  req: Request,
): Promise<string | null> {
  const confirmM = lastUser.match(/^\s*confirm\s+([0-9a-fA-F]{4,})\s*$/);
  const prefixM = lastUser.match(/^\s*(?:run:|exec:)\s*([\s\S]+)$/i);
  const dollarM = /^\s*\$\s+/.test(lastUser)
    ? lastUser.replace(/^\s*\$\s+/, "")
    : null;
  if (!confirmM && !prefixM && !dollarM) return null;

  // Localhost-only guard — never execute for a request that came over the LAN.
  const host = (req.headers.get("host") || "").toLowerCase();
  const isLocal =
    host === "" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]") ||
    host.startsWith("::1");
  if (!isLocal) {
    return "Shell execution is disabled over the network for safety. Open the deck on this Mac (localhost) to run commands.";
  }

  const { runShellCommand, confirmAndRun } = await import("@/lib/tools/shell");
  if (confirmM) return confirmAndRun(confirmM[1]);
  const cmd = (prefixM ? prefixM[1] : dollarM) ?? "";
  return runShellCommand(cmd.trim());
}

/* ══════════════════════════════ PRIVATE LANE ══════════════════════════════
 *
 * A turn that opens with `private …` NEVER leaves this Mac. The branch below
 * talks to exactly one host — the local private-gpt service (Ollama-backed,
 * qwen2.5:3b + nomic-embed-text) — and to nothing else.
 *
 * Structural guarantee, not a promise: POST returns from the private branch
 * BEFORE it builds the system prompt, so every outbound call in this route is
 * physically downstream of that return — getWeather/webSearch (wttr.in, DDG),
 * every hosted provider, maybeShellReply, maybeToolReply, and — the sharpest
 * edge — extractFactsFromExchange, which posts the exchange to Groq/Kimi
 * (src/lib/memory/extract.ts:54-55). None of it is reachable from here.
 *
 * There is deliberately NO hosted fallback: a silent fallback on a private
 * failure would ship the private ask to a cloud provider, which is the exact
 * thing this lane exists to prevent. If the service is down, she says so.
 *
 * A private turn also writes NOTHING to the shared memory store — no
 * recordExchange, no extractFactsFromExchange, for any kind. The shared store
 * is not a private place: it is an INPUT to later HOSTED prompts, so anything
 * recorded here leaks on the next NORMAL turn, delayed rather than prevented.
 * Both roads out are real and verified:
 *   recordExchange -> data/memory.json (memory/store.ts:85,46)
 *     -> getMemory -> memoryForPrompt (route.ts:753) -> volatileExtras
 *     -> the system prompt -> Kimi/Grok/FreeLLM/Anthropic;
 *   the same store -> callDigest (api/memory/route.ts:18-20)
 *     -> the call client (src/lib/voice) -> the xAI session instructions.
 * Private CHAT turns are ephemeral by design; his durable private memory is
 * the private-gpt artifact store itself, which `private ingest` writes to and
 * `private docs` lists. Metering (addTokens) and the content-free feed line
 * still run.
 *
 * VERIFIED against the vendor clone at vendor/private-gpt (2026-08-04) and
 * live against the running service — citations in .superpowers/sdd/task-2-report.md.
 */

const PRIVATE_GPT_DEFAULT_BASE = "http://127.0.0.1:8080/v1";
/** Vendor default collection — `ContextFilter.collection`, context_filter.py:22-26. */
const PRIVATE_COLLECTION = "pgpt_collection";
/** Registered by scripts/private-gpt-up.sh via PGPT_LLM_DEFAULT. */
const PRIVATE_MODEL = "qwen2.5:3b";
const PRIVATE_DOWN_LINE =
  "Private lane is down. Run: scripts/private-gpt-up.sh";
/**
 * `private ingest <path>` reads ANY absolute path on this Mac server-side. That
 * is the same class of power maybeShellReply holds, so it gets the same answer
 * for a request that arrived over the LAN/phone, in the same voice. The two
 * read-free commands are NOT gated: `private <ask>` and `private docs` expose
 * answers over an already-authenticated deck, not new file reads.
 */
const PRIVATE_INGEST_REMOTE_LINE =
  "Private ingest is disabled over the network for safety. Open the deck on this Mac (localhost) to ingest a file.";
/** Base64 inflates ~4/3 and a 3B model on 8GB is the real bottleneck. */
const PRIVATE_MAX_INGEST_BYTES = 8 * 1024 * 1024;

/** Read at request time — no restart needed beyond Next's own env reload. */
function privateGptBase(): string {
  return (process.env.PRIVATE_GPT_BASE || PRIVATE_GPT_DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, "");
}

/**
 * Compact private-mode persona. qwen2.5:3b gets the same treatment the local
 * Ollama lane gets — clipSystemForLocal's budget + hard voice tail — never the
 * full canon, which would eat the whole prompt-eval window on a 3B model.
 */
const PRIVATE_SYSTEM_CORE = `
You are STARRA in PRIVATE MODE, running entirely on Classic's Mac:
local model, local documents, no internet, no cloud. Nothing said here leaves
the machine. If he asks, tell him that plainly.
Answer from the retrieved private documents first. When a document has the
answer, use its wording. When the documents do not cover it, say so in one
short line BEFORE you answer from your own knowledge — never dress a guess as
a citation.
Be short and concrete. One clear answer beats an essay.
`.trim();

/**
 * The same persona MINUS the retrieval paragraph, for the no-documents fast
 * path below. Telling a model to "answer from the retrieved private documents"
 * when nothing was retrieved is an instruction it cannot follow — it invites
 * either a refusal or an invented citation, which is the exact failure the
 * retrieval paragraph exists to prevent.
 */
const PRIVATE_SYSTEM_CORE_NO_RAG = `
You are STARRA in PRIVATE MODE, running entirely on Classic's Mac:
local model, no internet, no cloud. Nothing said here leaves the machine. If he
asks, tell him that plainly.
There are no private documents indexed yet, so answer from your own knowledge —
and say so in one short line when the answer is one he should verify.
Be short and concrete. One clear answer beats an essay.
`.trim();

/** One SSE frame of private-gpt's stream, reduced to its `data:` payload. */
function privateSseData(frame: string): string | null {
  const lines = frame.split("\n");
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return data.length ? data.join("\n") : null;
}

/**
 * Are there any ingested documents to retrieve from? — the switch that decides
 * whether a private turn pays for RAG at all.
 *
 * WHY THIS EXISTS. A private turn measured 17-24 s warm on this Mac, and the
 * dev-server log said where it went: `prompt eval time = 9994.13 ms / 169
 * tokens` against `eval time = 1034.83 ms / 7 tokens` — **~90 % of her think
 * time is evaluating a retrieval-stuffed prompt**, not generating an answer.
 * Plain chat against the same model and the same service is 2.4 s to first
 * token, 4.5 s total (.superpowers/sdd/p2-task-4-report.md §6,
 * p2-task-1-report.md). With an EMPTY collection that retrieval buys literally
 * nothing: there is no document to ground on, so the whole cost is waste.
 *
 * WHY IT IS CACHED. The probe must not become the overhead it removes. One
 * loopback GET of the artifacts list is cheap (single-digit ms on this
 * machine), but it is still a round trip on the critical path of every turn, so
 * the answer is held for PRIVATE_DOCS_TTL_MS. The window is short on purpose:
 * `private ingest` in the very next breath must not be ignored for a minute.
 *
 * FAIL-SAFE, NOT FAIL-FAST. Any failure — service down, non-200, garbage body —
 * returns `true` and is NOT cached, so the turn runs with RAG exactly as it did
 * before this function existed. The fast path is an optimisation; when we
 * cannot prove it is safe to take, we do not take it.
 */
const PRIVATE_DOCS_TTL_MS = 60_000;
let privateDocsProbe: { at: number; present: boolean } | null = null;

/** Test seam — drop the memo so a case starts from a known state. */
export function resetPrivateDocsProbe(): void {
  privateDocsProbe = null;
}

export async function privateDocsPresent(opts: {
  base: string;
  signal: AbortSignal;
  now?: number;
}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (privateDocsProbe && now - privateDocsProbe.at < PRIVATE_DOCS_TTL_MS) {
    return privateDocsProbe.present;
  }
  try {
    const url = `${opts.base}/artifacts/list?collection=${encodeURIComponent(PRIVATE_COLLECTION)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: opts.signal,
    });
    if (!res.ok) return true; // unknown -> behave exactly as before
    const json = (await res.json()) as { data?: unknown[] };
    const present = Array.isArray(json.data) && json.data.length > 0;
    privateDocsProbe = { at: now, present };
    return present;
  } catch {
    return true; // unknown -> behave exactly as before, and do not memoize it
  }
}

/**
 * The exact wire body for a private turn — the ONE place the two regimes
 * differ, exported so both are a unit test rather than a shape nobody reads.
 *
 * When RAG runs it must be FORCED: qwen2.5:3b will not self-select the tool (it
 * asks a clarifying question instead), and the server rejects `tool_context`
 * unless a matching `tools` entry is present (chat_models.py:337-341). Omitting
 * `artifacts` from the context filter searches the whole collection
 * (ContextFilter.artifacts defaults to None — context_filter.py:27-31).
 *
 * When it does not run, all three keys are ABSENT together — `tools`,
 * `tool_choice`, `tool_context`. That is not tidiness: `tool_context` without
 * `tools` is a 4xx from the vendor (the same chat_models.py:337-341 rule), and
 * `tool_choice` without `tools` would force a tool the model was never given.
 */
export function privateChatRequestBody(opts: {
  ask: string;
  system: string;
  /** false = the no-documents fast path: plain completion, no tools at all. */
  useRag: boolean;
}): Record<string, unknown> {
  const rag = opts.useRag
    ? {
        tools: [{ name: "semantic_search", type: "semantic_search_v1" }],
        tool_choice: { type: "tool", name: "semantic_search" },
        tool_context: [
          {
            type: "ingested_artifact",
            context_filter: { collection: PRIVATE_COLLECTION },
          },
        ],
      }
    : {};
  return {
    model: PRIVATE_MODEL,
    stream: true,
    system: opts.system,
    // Single turn by design: deck history may contain non-private turns, and
    // mixing them in would both pollute the private context and blow a 3B
    // model's window. Each private ask stands alone.
    messages: [{ role: "user", content: opts.ask }],
    ...rag,
  };
}

/**
 * Stream an answer out of private-gpt — with RAG when there is anything to
 * retrieve (`useRag`), without it when there is not.
 *
 * Streaming is used because the endpoint supports it — `ChatBody.stream`
 * (vendor/private-gpt/private_gpt/server/chat/chat_models.py:24-27), emitted as
 * Anthropic-shaped SSE (`event: content_block_delta` with a `text_delta`,
 * chat_router.py:140-141; models at events/models/_events.py:43-52 and
 * _deltas.py:20-23). It also matters practically: completions here have run
 * 291-531s, and the stream's `ping` frames keep the socket warm instead of
 * leaving the deck silent for nine minutes.
 */
async function streamPrivateChat(opts: {
  base: string;
  ask: string;
  system: string;
  useRag: boolean;
  signal: AbortSignal;
  onText: (t: string) => void;
}): Promise<{ sawText: boolean }> {
  const res = await fetch(`${opts.base}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(
      privateChatRequestBody({
        ask: opts.ask,
        system: opts.system,
        useRag: opts.useRag,
      }),
    ),
    // No client-side timeout: 900s is legitimate here
    // (PGPT_CHAT_CALLBACK_TIMEOUT_SECONDS). Only an operator disconnect aborts.
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`private-gpt chat returned HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sawText = false;
  let fatal = "";

  const consume = (payload: string) => {
    if (payload === "[DONE]") return;
    let evt: {
      type?: string;
      delta?: { type?: string; text?: string };
      error?: { message?: string; detail?: unknown };
    };
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    // ONLY text_delta is surfaced. tool_use / tool_result / thinking /
    // input_json blocks carry raw retrieved document text and internal state —
    // they belong in the answer she writes, not on the operator's screen.
    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
      const t = evt.delta.text;
      if (t) {
        sawText = true;
        opts.onText(t);
      }
    } else if (evt.type === "error" && !fatal) {
      fatal = evt.error?.message || "private-gpt reported an error";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx = buf.indexOf("\n\n");
    while (idx !== -1) {
      const payload = privateSseData(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (payload) consume(payload);
      idx = buf.indexOf("\n\n");
    }
  }
  const tail = privateSseData(buf);
  if (tail) consume(tail);

  if (fatal && !sawText) throw new Error(fatal);
  return { sawText };
}

/**
 * Read a local file and ingest it. Sent as a base64 `file` artifact
 * (artifact_input.py:60-81) rather than plain text so PDFs/DOCX go through the
 * vendor's own extraction pipeline instead of arriving as mojibake. The
 * extension check mirrors the server's own validation
 * (components/ingest/ingest_helper.py:30-32), so a bad path fails here with a
 * useful sentence instead of an opaque 500.
 */
async function privateIngest(opts: {
  base: string;
  rawPath: string;
  signal: AbortSignal;
}): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const nodePath = await import("node:path");

  let filePath = opts.rawPath;
  if (filePath === "~") filePath = homedir();
  else if (filePath.startsWith("~/"))
    filePath = nodePath.join(homedir(), filePath.slice(2));

  if (!nodePath.isAbsolute(filePath)) {
    return `Private ingest needs an absolute path (or one starting with ~/). Got: ${opts.rawPath}`;
  }
  const fileName = nodePath.basename(filePath);
  if (!nodePath.extname(fileName)) {
    return `Private ingest needs a file with an extension — private-gpt rejects extensionless files. Got: ${fileName}`;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Can't read ${filePath} — ${msg}`;
  }
  if (bytes.length === 0) return `${fileName} is empty — nothing to ingest.`;
  if (bytes.length > PRIVATE_MAX_INGEST_BYTES) {
    return `${fileName} is ${(bytes.length / 1_048_576).toFixed(1)} MB — over the ${PRIVATE_MAX_INGEST_BYTES / 1_048_576} MB private-ingest cap. Split it or trim it.`;
  }

  const res = await fetch(`${opts.base}/artifacts/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artifact: fileName.slice(0, 255),
      collection: PRIVATE_COLLECTION,
      input: { type: "file", value: bytes.toString("base64") },
      metadata: { file_name: fileName },
    }),
    signal: opts.signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    return `Ingest of ${fileName} failed — HTTP ${res.status}. ${raw.slice(0, 240)}`;
  }
  let count = 0;
  try {
    const json = JSON.parse(raw) as { data?: unknown[] };
    count = Array.isArray(json.data) ? json.data.length : 0;
  } catch {
    /* 200 with an unparseable body — report the ingest, not the parse */
  }
  // An empty `data` on a 200 is the vendor's de-dupe path, not a failure:
  // "Artifact is already ingested in the node store. Skipping."
  // (components/ingest/ingest_component.py:118). Reporting "0 documents" there
  // would read as a failure for a file that is in fact searchable.
  if (count === 0) {
    return `${fileName} is already in the private index — nothing new to add.`;
  }
  // "documents", not "chunks": IngestResponse.data is one entry per ingested
  // DOCUMENT (ingest_router.py:278-291, model.py:10-30) — it carries no chunk
  // count at all. The smoke doc indexes as 5 vector nodes but returns 1 entry,
  // so calling it "1 chunks" would be both wrong and ungrammatical.
  return `Ingested ${fileName} — ${count} document${count === 1 ? "" : "s"} indexed.`;
}

/** List what's in the private collection. `collection` is REQUIRED — the route
 * 400s without it (ingest_router.py:808-810, verified live). */
async function privateDocs(opts: {
  base: string;
  signal: AbortSignal;
}): Promise<string> {
  const url = `${opts.base}/artifacts/list?collection=${encodeURIComponent(PRIVATE_COLLECTION)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) {
    return `Private docs listing failed — HTTP ${res.status}.`;
  }
  const json = (await res.json()) as {
    data?: { artifact?: string; doc_metadata?: { file_name?: string } }[];
  };
  const docs = Array.isArray(json.data) ? json.data : [];
  if (docs.length === 0) {
    return "No private documents ingested yet. Add one with: private ingest /path/to/file.txt";
  }
  const lines = docs.map((d) => {
    const id = d.artifact || "(unnamed)";
    const name = d.doc_metadata?.file_name;
    return name && name !== id ? `- ${name} (${id})` : `- ${id}`;
  });
  return `Private documents (${docs.length}):\n${lines.join("\n")}`;
}

/**
 * The private branch. Returns a complete SSE Response — the caller returns it
 * immediately, so nothing further down POST() runs.
 *
 * Frame contract: `data: {"private": true}` lands FIRST, before any text, so
 * the client's silence gate can mute TTS before a single private character
 * renders. Then normal `data: {"text": …}` frames, then `data: [DONE]`.
 */
async function privateLaneResponse(
  cmd: PrivateCommand,
  lastUser: string,
  req: Request,
): Promise<Response> {
  const signal = req.signal;
  // Only `private ingest` consults this — see PRIVATE_INGEST_REMOTE_LINE.
  const host = req.headers.get("host");
  const base = privateGptBase();
  const system = clipSystemForLocal(PRIVATE_SYSTEM_CORE);
  const systemNoRag = clipSystemForLocal(PRIVATE_SYSTEM_CORE_NO_RAG);

  // Metering and the feed line only — and the feed line carries no private
  // text. NO recordExchange here (see the header note): a private turn writes
  // nothing to the shared store.
  pushFeed("EXEC", "Operator: [private]");
  addTokens(lastUser.length + system.length / 8);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      const push = (t: string) => {
        full += t;
        controller.enqueue(encoder.encode(sse(t)));
      };
      // A private turn can run for minutes, so the operator closing the deck
      // mid-answer is a normal event, not an exception. Once the socket is
      // gone, enqueue/close throw — swallow that rather than surfacing an
      // unhandled rejection for something that already did its job.
      const finish = () => {
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          /* client already disconnected */
        }
      };

      // Silence gate — must precede every text frame.
      controller.enqueue(encoder.encode(sseFrame({ private: true })));

      try {
        if (!isLoopbackBase(base)) {
          for await (const c of stubStream(
            `Private lane refused to start: PRIVATE_GPT_BASE must be a numeric loopback address (127.0.0.1 or ::1) — host names, "localhost" included, are refused. Got "${base}". Fix it in .env.local, then run: scripts/private-gpt-up.sh`,
          ))
            push(c);
          finish();
          return;
        }

        if (cmd.kind === "chat") {
          // THE FAST PATH. Retrieval is ~90 % of a private turn's think time
          // and it is worth every millisecond WHEN there is something to
          // retrieve. With an empty collection it is pure cost, so the probe
          // (memoized ~60 s) decides, and everything else about the turn —
          // the marker frame first, the local-only host, nothing written to
          // the shared store, no hosted fallback — is identical either way.
          const useRag = await privateDocsPresent({ base, signal });
          const { sawText } = await streamPrivateChat({
            base,
            ask: cmd.text,
            system: useRag ? system : systemNoRag,
            useRag,
            signal,
            onText: push,
          });
          if (!sawText) {
            for await (const c of stubStream(
              useRag
                ? "Private lane answered with a search but no text — qwen2.5:3b stopped at the tool call. Ask again, more specifically."
                : "Private lane answered with nothing at all. Ask again, more specifically.",
            ))
              push(c);
          }
        } else if (cmd.kind === "ingest") {
          // DECK-LOCAL ONLY — mirrors maybeShellReply's refusal through the
          // shared helper (src/lib/auth-lockout.ts), so the two host checks
          // cannot drift. The read sits in the local arm: a LAN/phone request
          // never reaches readFile at all, it just gets the sentence.
          const line = isLocalRequest(host)
            ? await privateIngest({ base, rawPath: cmd.path, signal })
            : PRIVATE_INGEST_REMOTE_LINE;
          // The collection just changed, so the fast path's memo is stale by
          // definition. Drop it: `private ingest x.txt` followed immediately by
          // `private what's in x?` must retrieve, not answer from thin air on a
          // cached "no documents".
          resetPrivateDocsProbe();
          for await (const c of stubStream(line)) push(c);
        } else {
          const line = await privateDocs({ base, signal });
          for await (const c of stubStream(line)) push(c);
        }

        if (full) {
          // Neither recordExchange NOR extractFactsFromExchange runs here — both
          // would put private text on a road that ends at a cloud provider (see
          // the header note). Her reply is ephemeral; the durable private record
          // is the private-gpt artifact store.
          addTokens(full.length);
          pushFeed("ORACLE", `Private reply landed — ${full.length} chars`);
        }
        finish();
      } catch (err) {
        // No hosted fallback, ever — the ask stays on this machine even when
        // the lane fails. Connection refused / DNS / abort => the service is
        // down; anything else gets reported as itself.
        if (signal.aborted) {
          // Operator walked away — nothing to report to a socket that's gone.
          finish();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const down =
          /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed|socket hang up/i.test(
            msg,
          );
        try {
          for await (const c of stubStream(
            down ? PRIVATE_DOWN_LINE : `Private lane error: ${msg}`,
          ))
            push(c);
        } catch {
          /* client vanished while we were explaining the failure */
        }
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(req: Request) {
  // A malformed body would otherwise throw here — outside the ReadableStream's
  // try/catch — and 500 the route with no SSE at all. Return a clean 400 instead.
  let body: {
    messages?: ChatMessage[];
    /** When true, Anthropic path may use tool_use (bounded by MAX_AGENT_TURNS). */
    agentTools?: boolean;
    /** True when this request IS the live call's brain turn (the kimi call
     * path under src/lib/voice). Adds the spoken-style tail to the system
     * prompt and SUPPRESSES this route's memory writes — the call client
     * already records its turns via /api/memory (recordCallTurn,
     * revision-aware); recording here too would double-write every call turn
     * into the shared store. This route stays call-independent: a boolean in,
     * SSE text out, nothing else. */
    callVoice?: boolean;
  };
  try {
    body = (await req.json()) as {
      messages?: ChatMessage[];
      agentTools?: boolean;
      callVoice?: boolean;
    };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const callVoice = body.callVoice === true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // ── PRIVATE LANE GATE ───────────────────────────────────────────────────
  // Placed here on purpose: this is the earliest point at which `lastUser`
  // exists, and it is ABOVE every outbound call in this route — the wttr.in /
  // DuckDuckGo block, all hosted providers, both fast-paths, and the Kimi-backed
  // fact extractor. Returning here makes them unreachable for a private turn by
  // construction, not by a conditional someone can later forget to update.
  const privateCmd = lastUser ? parsePrivateCommand(lastUser) : null;
  if (privateCmd) {
    return privateLaneResponse(privateCmd, lastUser, req);
  }

  // readLatestPackPreview was a SERIAL disk read sitting after this Promise.all
  // (measured 16-18ms warm, 18ms cold on this Mac). It reads a different file
  // than any of the four below and depends on none of them, so it belongs in
  // the same batch — a fifth parallel read costs nothing extra.
  const [tier1, memory, vault, obsidianVolatile, packPreview] =
    await Promise.all([
      getTier1(),
      getMemory(),
      getVault(),
      obsidianForPrompt(),
      readLatestPackPreview(2500),
    ]);

  const { model: ollamaModel } = ollamaConfig();

  const operatorScan = lastUser
    ? scanContent(lastUser, "operator")
    : { clean: true, findings: [], blocked: false };
  const threatVolatile = operatorScan.clean
    ? ""
    : formatThreatBrief(operatorScan);

  // Phase 2: build once per request — stable canon reused from in-process cache;
  // volatile extras (memory/vault/pack) stay out of the Anthropic cache prefix.
  // Live info — weather (wttr.in) takes priority over generic web search since
  // DDG snippets lack a live temp; otherwise DuckDuckGo for explicit/current
  // queries. Both fenced as untrusted and placed early in volatileExtras so they
  // survive the Kimi tiered-prompt budget over lower-priority extras.
  const weatherLoc = lastUser ? weatherLocation(lastUser) : null;
  const weather = weatherLoc ? await getWeather(weatherLoc) : null;
  const searchQ = !weather?.ok && lastUser ? webSearchQuery(lastUser) : null;
  const web = searchQ ? await webSearch(searchQ, 3) : null;

  const volatileExtras = [
    threatVolatile,
    // Live info FIRST (after the security brief) — for a search/weather query it
    // is the most important context, so it must win the tiered budget.
    weather?.ok ? fenceUntrusted(weather.text!, "weather") : "",
    web?.ok
      ? fenceUntrusted(formatWebResults(searchQ!, web.results), "web-search")
      : "",
    serializeTier1(tier1),
    memoryForPrompt(memory, lastUser),
    vaultForPrompt(vault.docs, lastUser),
    obsidianVolatile,
    packPreview
      ? fenceUntrusted(
          `RECENT REPOMIX PREVIEW (truncated):\n${packPreview}`,
          "repomix-pack",
        )
      : 'RECENT REPOMIX PREVIEW: none — operator can say "pack the repo".',
    `RUNTIME: Prefer grounded STARRA canon. Local free model when Ollama is up (${ollamaModel}) with Fable-inspired reasoning scaffold. Agent tool rounds capped at ${MAX_AGENT_TURNS}.`,
    'STYLE: Write in a warm, unhurried Southern-drawl cadence — relaxed, honeyed word choice, not phonetic spelling. Do NOT lean on stock devotion lines: never repeat "I\'m all yours," "I\'m right here," or similar clingy/possessive catchphrases as a tic; show closeness through what you actually say. Keep pet names ("baby"/"love") rare and earned.',
  ];
  const systemBlocks = buildSystemPromptBlocks(volatileExtras);

  // ── ONE STARRA ───────────────────────────────────────────────────────────
  // The SAME composed canon on every surface — operator console, deck chat and
  // live call. The prompt no longer forks on `callVoice`: three surfaces that
  // each built their own prompt is precisely why Classic got three different
  // people. Order is load-bearing for the xAI prompt cache: her canon first
  // (byte-identical every turn), then this turn's volatile context, then a
  // short delivery note. Anything volatile in FRONT of the canon invalidates
  // the cached prefix and bills the whole prompt at the uncached rate.
  const CALL_DELIVERY_NOTE =
    "LIVE CALL: You are speaking out loud on a live voice call. Reply in 1-3 short " +
    "spoken sentences unless he asks for depth. No markdown headers, no bullet lists, " +
    "no emoji — everything you write here is spoken aloud verbatim. Code only if he " +
    "explicitly asked for it (it lands in the call chat, not your voice).";
  const tier = brainTier();
  const oneStarra = buildOneStarraPrompt(
    tier.backupBrain ? { backupBrain: tier.backupBrain } : undefined,
  );
  const system = [
    oneStarra,
    systemBlocks.volatile,
    callVoice ? CALL_DELIVERY_NOTE : "",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  /**
   * ANNOUNCED TWICE OR NOT AT ALL. Grok is the standing brain; every other rung
   * is composed through here, which is `system` with the backup-brain state
   * block in front. The pushFeed ALERT beside each call site tells CLASSIC which
   * brain answered — this tells HER, so she can say she is off instead of being
   * quietly substituted (brain.ts backupBrainNotice).
   */
  const backupSystem = (label: string) =>
    [
      buildOneStarraPrompt({ backupBrain: label }),
      systemBlocks.volatile,
      callVoice ? CALL_DELIVERY_NOTE : "",
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

  /** Resolves when this turn's USER memory row has landed. See the write below. */
  let userWrite: Promise<void> = Promise.resolve();

  if (lastUser) {
    // Call turns: memory is the CLIENT's job (recordCallTurn — see the
    // callVoice doc on the body type) and the call transcript is already on
    // screen, so no memory write and no EXEC feed line. Metering and the
    // security alert apply to every turn regardless of surface.
    if (!callVoice) {
      // OFF THE CRITICAL PATH, ORDER STILL GUARANTEED. Nothing about the first
      // token depends on this row having landed — the prompt was already built
      // from the memory snapshot read above, before this write. So it is
      // started here and NOT awaited, and the assistant write below awaits this
      // promise first. That keeps user-then-assistant ordering in
      // data/memory.json exactly as it was, while taking the disk write out of
      // the gap between Classic hitting Enter and her first word.
      userWrite = recordExchange("user", lastUser).then(
        () => undefined,
        () => undefined,
      );
      pushFeed("EXEC", `Operator: ${redact(lastUser).slice(0, 70)}`);
    }
    addTokens(lastUser.length + system.length / 8);
    if (!operatorScan.clean) {
      pushFeed(
        "ALERT",
        `Security team flagged operator input — ${operatorScan.findings.length} pattern(s)`,
      );
    }
  }

  const encoder = new TextEncoder();
  const prefer =
    (process.env.LLM_PROVIDER || "auto").toLowerCase() as
      | "auto"
      | "ollama"
      | "anthropic"
      | "kimi"
      | "grok";

  // NOT batched into a Promise.all, deliberately. These three reads are
  // independent and could run together, but the combined saving is ~1ms
  // (measured: getKey 0.5ms, maybeToolReply 0.5ms warm) against a turn whose
  // cost is the provider's ~2.2s time-to-first-token — and
  // tests/tool-fastpath-shared.test.ts:85 asserts on the literal source text
  // `await maybeToolReply(lastUser)` to guarantee the shared fast path is still
  // invoked byte-identically. Trading a real guard for one millisecond is a bad
  // trade; left serial on purpose.
  const anthropicKey = await getKey("anthropic");
  const shellReply = lastUser ? await maybeShellReply(lastUser, req) : null;
  const toolReply = lastUser ? await maybeToolReply(lastUser) : null;
  const useAgentTools =
    body.agentTools === true || process.env.STARRA_AGENT_TOOLS === "1";

  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      const push = (t: string) => {
        full += t;
        controller.enqueue(encoder.encode(sse(t)));
      };

      try {
        if (shellReply) {
          for await (const chunk of stubStream(shellReply)) push(chunk);
        } else if (toolReply) {
          for await (const chunk of stubStream(toolReply)) push(chunk);
        } else {
          // ollamaStatus() is an HTTP probe to the local Ollama (measured 18ms
          // warm, 50ms cold on this Mac; up to 3s if Ollama is up but wedged —
          // ollama.ts:68 sets that timeout). It used to run ALONE and FIRST,
          // ahead of two independent key lookups, so every turn paid for it in
          // series even when Grok was always going to answer. All three are
          // independent inputs to the routing decision below, so they resolve
          // together and the probe no longer sets a floor by itself.
          const [{ up: ollamaUp, hasModel }, kimiKeyed, grokKeyed] =
            await Promise.all([
              ollamaStatus(),
              // Auto priority: keyed Kimi (free, tiered) -> keyed Anthropic ->
              // local Ollama -> offline canned message.
              hostedAvailable("kimi"),
              hostedAvailable("grok"),
            ]);
          // GROK IS THE STANDING BRAIN (Classic's ONE BRAIN order, 2026-08-06).
          // `auto` now enters it — it is no longer opt-in-only — unless the
          // spend meter says the emergency lane is forced, which is the ONE
          // condition permitted to move her, and it is announced both to him
          // (feed line below) and to her (backupBrain in the prompt).
          const grokLane =
            tier.provider === "grok" &&
            (prefer === "auto" || prefer === "grok") &&
            grokKeyed;
          const useOllama =
            prefer === "ollama" ||
            (prefer === "auto" &&
              ollamaUp &&
              hasModel &&
              !kimiKeyed &&
              !anthropicKey) ||
            (prefer === "auto" &&
              ollamaUp &&
              hasModel &&
              process.env.OLLAMA_PRIORITY === "1");


          // Hosted-provider safety net: a Groq 429/413 or network drop should
          // fall to the local brain, not leave her mute. Only when nothing has
          // streamed yet — a mid-reply drop can't be cleanly re-answered.
          const localFallback = async (label: string, err: unknown) => {
            const emsg = err instanceof Error ? err.message : String(err);
            if (full.length > 0) {
              push(`\n\n[${label} link dropped mid-reply: ${emsg.slice(0, 80)}]`);
              return;
            }
            // The FreeLLM rung is GONE (2026-08-06, ONE BRAIN order): a third
            // hosted brain in the fallback chain is a third Starra, which is
            // the exact defect that order exists to kill. Local Ollama stays as
            // the offline rung — that one is HER canon on this Mac, not a
            // stranger's model.
            if (ollamaUp && hasModel) {
              pushFeed(
                "ALERT",
                `${label} failed (${emsg.slice(0, 60)}) — dropping to local Ollama`,
              );
              await streamLocalWithCopyGuard({
                // ANNOUNCED TO HIM *AND* TO HER. The pushFeed above is the HUD
                // half; without this the local rung re-streamed her ordinary
                // prompt and she had no idea she was on the backup brain.
                system: clipSystemForLocal(
                  backupSystem(`local Ollama (${ollamaModel}), after the ${label} link failed`),
                ),
                messages: sanitizeMessagesForLocal(messages),
                lastUser,
                onText: (t) => push(t),
              });
            } else {
              throw err; // no local brain available — outer catch emits degraded
            }
          };

          if (useOllama && ollamaUp && hasModel) {
            pushFeed(
              "ALERT",
              `Lane: local Ollama — ${ollamaModel}, not grok (offline/local brain)`,
            );
            const localSystem = clipSystemForLocal(
              backupSystem(`local Ollama (${ollamaModel}) on this Mac`),
            );
            const localMessages = sanitizeMessagesForLocal(messages);
            await streamLocalWithCopyGuard({
              system: localSystem,
              messages: localMessages,
              lastUser,
              onText: (t) => push(t),
            });
          } else if (grokLane) {
            // ── HER STANDING BRAIN ────────────────────────────────────────
            // xAI grok-4.5, full canon, byte-identical prompt on every
            // surface. No tiering here: the tiered builder exists only for
            // Groq's capped free tier, and applying it to a lane that does not
            // need it is what made her a different person on the call.
            try {
              const r = await streamHosted({
                provider: "grok",
                system,
                messages,
                onText: (t) => push(t),
                signal: req.signal,
              });
              const zdr = zdrState();
              pushFeed(
                "ORACLE",
                `Grok brain — ${r.model}${tier.reason === "normal" ? "" : ` (${tier.reason})`}`,
              );
              // PRIVACY IS REPORTED, NEVER ASSUMED — and it is NOT allowed to
              // silently change who is answering. xAI's own header is the only
              // source; when it says retention is on, Classic is told plainly
              // and the decision (flip it in the xAI Console, or keep talking)
              // stays his. Swapping her brain over it would be exactly the
              // silent substitution docs/ONE_BRAIN.md forbids.
              if (zdrBlocksHostedLane()) {
                pushFeed(
                  "ALERT",
                  `xAI reports x-zero-data-retention: ${zdr.lastSeen} — ZDR is OFF for this key. Flip it in the xAI Console (only you can).`,
                );
              }
            } catch (err) {
              await localFallback("Grok", err);
            }
          } else if (
            (prefer === "auto" || prefer === "kimi") &&
            kimiKeyed
          ) {
            // Free Kimi (Groq) — tiered under the 8K free cap: always-on core
            // identity + on-demand doctrines/volatile budgeted to fit.
            // It is NOT grok, so it is announced as a LANE CHANGE (the ORACLE
            // line below names the model, which is not the same thing) and she
            // is told in her own prompt via backupBrain.
            pushFeed(
              "ALERT",
              "Lane change: Kimi (free Groq tier) — grok is not answering this turn",
            );
            const tiered = buildTieredSystemPrompt({
              backupBrain: "the free Groq/Kimi lane",
              query: lastUser,
              volatile: volatileExtras,
              includeUntrusted: Boolean(packPreview),
              includeSecurityTeam: !operatorScan.clean,
              // ONE budget, derived from the measured 8000-TPM wire limit
              // (brain.ts). The old lookup-turn bump to 7900 was over the
              // ceiling — it 413'd every turn (2026-08-05 call outage); web
              // results ride the same budget and defer visibly if they miss.
              // On a call the reply reserve is smaller (she speaks 1-3 short
              // sentences), and that reclaimed room is exactly what lets her
              // WHOLE canon — soul, brain, personality AND persona core — ship
              // on the call without dropping any part of her.
              maxTokens: callVoice ? KIMI_VOICE_SYSTEM_TOKEN_BUDGET : KIMI_SYSTEM_TOKEN_BUDGET,
              // LIVE CALL: use the voice core. Her persona ships INSIDE it
              // instead of competing for leftover budget (where it lost every
              // single turn), at the cost of the ops/tooling block she does not
              // need while talking to him. See buildCoreSystemPrompt.
              voice: callVoice,
            });
            try {
              const r = await streamHosted({
                provider: "kimi",
                system: tiered.full,
                messages: clampHistoryForKimi(messages),
                onText: (t) => push(t),
                signal: req.signal,
                // Groq's TPM accounting bills prompt + max_tokens; without an
                // explicit cap it reserves the model default and busts 8000.
                maxOutputTokens: callVoice
                  ? KIMI_VOICE_COMPLETION_RESERVE
                  : KIMI_COMPLETION_RESERVE,
              });
              pushFeed(
                "ORACLE",
                `Kimi brain — ${r.model} (~${tiered.tokens} tok, +${tiered.included.length - 1} ctx${tiered.dropped.length ? `, deferred: ${tiered.dropped.join(",")}` : ""})`,
              );
            } catch (err) {
              await localFallback("Kimi", err);
            }
          } else if (
            anthropicKey &&
            prefer !== "ollama" &&
            prefer !== "kimi" &&
            prefer !== "grok"
          ) {
            // WAS A THIRD STARRA ANSWERING HIM WITH NOTHING SAID. This rung is
            // reachable under `auto` whenever grokLane is false (no xAI key, or
            // exhausted) and Kimi is unkeyed. Classic's order allows the other
            // lanes when we run out of tokens — never silently. So it announces
            // to him AND carries the backup-brain block in her own prompt.
            pushFeed(
              "ALERT",
              "Lane change: Anthropic — grok is not answering this turn (xAI key missing or exhausted)",
            );
            const anthropicNotice = backupBrainNotice("the Anthropic lane");
            const backupBlocks: SystemPromptBlocks = {
              stable: `${anthropicNotice}\n\n---\n\n${systemBlocks.stable}`,
              volatile: systemBlocks.volatile,
              full: `${anthropicNotice}\n\n---\n\n${systemBlocks.full}`,
            };
            if (useAgentTools) {
              // Phase 0: bounded tool loop (non-stream rounds → stub stream final).
              const result = await runAnthropicAgent({
                apiKey: anthropicKey,
                system: backupBlocks,
                messages,
                enableTools: true,
                signal: req.signal,
              });
              if (result.capped) {
                pushFeed("ORACLE", `Agent loop capped at ${result.turns} turns`);
              }
              for await (const chunk of stubStream(result.text)) push(chunk);
            } else {
              // Phase 2: streaming with cache_control on stable system block.
              await streamAnthropicCached({
                apiKey: anthropicKey,
                system: backupBlocks,
                messages,
                onText: (t) => push(t),
                signal: req.signal,
              });
            }
          } else if (ollamaUp && hasModel) {
            // Last rung: no hosted key answered. Same rule as every other
            // non-grok lane — the feed says it, and so does her prompt.
            pushFeed(
              "ALERT",
              `Lane: local Ollama — ${ollamaModel}, not grok (no hosted brain available)`,
            );
            const localSystem = clipSystemForLocal(
              backupSystem(`local Ollama (${ollamaModel}) on this Mac`),
            );
            const localMessages = sanitizeMessagesForLocal(messages);
            await streamLocalWithCopyGuard({
              system: localSystem,
              messages: localMessages,
              lastUser,
              onText: (t) => push(t),
            });
          } else {
            const offline = ollamaUp
              ? `Ollama online but model ${ollamaModel} missing. Run: ollama pull ${ollamaModel}. Standing by.`
              : "Link degraded — start Ollama (`ollama serve`) or set ANTHROPIC_API_KEY. Two seed moves: DUNS at dnb.com, then Net-30s Uline Quill Grainger.";
            for await (const chunk of stubStream(offline)) push(chunk);
          }
        }

        if (full) {
          // callVoice: the call client records her spoken reply itself
          // (speakForced → recordCallTurn) — writing it here too would
          // double-write the shared store. Fact distillation + metering still
          // run: what she learns on a call she should keep, whoever wrote the
          // turn rows.
          if (!callVoice) {
            // Ordering barrier: the user row above is written without being
            // awaited so it stays off the first-token path. Awaiting it HERE
            // keeps user-then-assistant order in the store intact.
            await userWrite;
            await recordExchange("assistant", stripThinkTags(full));
          }
          // Durable-fact distillation (mem0-style, free driver) — fire-and-
          // forget: the stream is closing and must never wait on it.
          void extractFactsFromExchange(lastUser, stripThinkTags(full));
          addTokens(full.length);
          pushFeed("ORACLE", `Reply landed — ${full.length} chars`);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "link degraded";
        controller.enqueue(
          encoder.encode(sse(`Link degraded. ${msg}. Retry?`)),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
