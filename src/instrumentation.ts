/**
 * Next.js instrumentation hook — the process-wide error net. Registers once
 * per server boot (nodejs runtime only): unhandled rejections and uncaught
 * exceptions land in the errors table instead of vanishing into the log.
 * Handlers OBSERVE only — they never exit the process (dev keeps running,
 * the watchdog owns lifecycle).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureError } = await import("@/lib/errlog");
  process.on("unhandledRejection", (reason) => {
    captureError("unhandledRejection", reason);
  });
  process.on("uncaughtException", (err) => {
    captureError("uncaughtException", err);
  });
}
