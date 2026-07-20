/** Design Spec §10 — operator microcopy only */
export const COPY = {
  boot: [
    "INITIALIZING STARGATE KERNEL",
    "LOADING MEMORY BANKS ... READY",
    "LINKING STARRA BRAIN ... OK",
    "LOADING STARRA SOUL ... OK",
    "VOICE LOOP + OLLAMA ... ONLINE",
    "DRAGON TRADAR MODULE ... DEMO MODE",
    "THINK TANK ENSEMBLE ... DEMO MODE",
    "ALL SYSTEMS NOMINAL",
  ],
  idle: "STANDING BY",
  listening: "LISTENING",
  transcribing: "TRANSCRIBING",
  thinking: "PROCESSING",
  streaming: "TRANSMITTING",
  speaking: "TRANSMITTING",
  tool: "EXECUTING",
  error: "LINK DEGRADED. RETRY?",
  offline: "OFFLINE. RECENT CONTEXT AVAILABLE.",
  emptyInbox: "NOTHING PENDING.",
  emptyPipeline: "NO ACTIVE FRONTS.",
  confirmDestructive: "CONFIRM. THIS CANNOT BE UNDONE.",
  tapToSpeak: "TAP TO SPEAK",
  voiceUnavailable: "VOICE LINK UNAVAILABLE",
  systemsNominal: "ALL SYSTEMS NOMINAL",
  send: "SEND",
  mic: "MIC",
} as const;

export function statusForState(
  state: import("./tokens").HudState,
  toolName?: string,
): string {
  switch (state) {
    case "idle":
      return COPY.idle;
    case "wake":
      return COPY.listening;
    case "listening":
      return COPY.listening;
    case "transcribing":
      return COPY.transcribing;
    case "thinking":
      return COPY.thinking;
    case "streaming":
    case "speaking":
      return COPY.speaking;
    case "tool":
      return toolName ? `${COPY.tool} — ${toolName.toUpperCase()}` : COPY.tool;
    case "error":
      return COPY.error;
    case "offline":
      return COPY.offline;
    default:
      return COPY.systemsNominal;
  }
}
