/**
 * FAKE TWILIO — speaks the Media Streams protocol at our bridge and captures
 * the mu-law she sends back. This is the end-to-end proof: if audio arrives
 * here, the only untested link left is Twilio itself.
 */
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

// Default: the local bridge. Pass a url to exercise the PUBLIC path instead —
// `node test/fake-twilio.mjs wss://<host>/stream` proves the tunnel carries a
// WebSocket, which is the leg Twilio actually uses and the one most likely to
// be silently broken by a proxy that only forwards plain HTTP.
const TARGET = process.argv[2] || "ws://127.0.0.1:8790/stream";
console.log(`[fake-twilio] connecting to ${TARGET}`);
const ws = new WebSocket(TARGET);
const chunks = [];
let events = 0;

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({
    event: "start",
    start: {
      streamSid: "MZfake0000000000000000000000000001",
      callSid: "CAfake0000000000000000000000000001",
      customParameters: { direction: "outbound", name: "Jane", to: "+19185550123" },
    },
  }));
  // 2s of mu-law silence so server VAD sees a live inbound stream
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  let n = 0;
  const t = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || n++ > 100) return clearInterval(t);
    ws.send(JSON.stringify({ event: "media", media: { payload: silence } }));
  }, 20);
});

// A harness with no error handler reports a refused connection as "0 bytes",
// which reads like a broken bridge. Say what actually happened.
ws.on("error", (e) => console.error(`[fake-twilio] SOCKET ERROR: ${e.message}`));
ws.on("unexpected-response", (_req, res) =>
  console.error(`[fake-twilio] handshake rejected: HTTP ${res.statusCode}`));
ws.on("close", (code, reason) =>
  console.log(`[fake-twilio] closed: ${code} ${reason?.toString?.() || ""}`));
ws.on("open", () => console.log("[fake-twilio] socket open"));

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  events++;
  if (m.event === "media") chunks.push(Buffer.from(m.media.payload, "base64"));
  if (m.event === "clear") console.log("  <- clear (barge-in)");
});

setTimeout(() => {
  const audio = Buffer.concat(chunks);
  console.log(`events from bridge: ${events}`);
  console.log(`mu-law audio received: ${audio.length} bytes (~${(audio.length / 8000).toFixed(2)}s at 8kHz)`);
  if (audio.length) writeFileSync("logs/her_greeting.ulaw", audio);
  try { ws.close(); } catch {}
  process.exit(audio.length > 0 ? 0 : 1);
}, 14000);
