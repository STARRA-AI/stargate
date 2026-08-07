import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

export const runtime = "nodejs";

/** Resolve a real python3 — a GUI-launched server may not have it on PATH. */
function resolvePython(): string {
  for (const p of [
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/bin/python3",
  ]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* keep trying */
    }
  }
  return "python3"; // last resort: rely on PATH
}

/**
 * Launch the STARRA talking-avatar desktop app (~/STARGATE/starra-avatar).
 * The deck server runs on this Mac, so it spawns the Python app locally and
 * hands it the deck's env (XAI_API_KEY flows through automatically). Localhost
 * only — a LAN/phone client can never spawn desktop processes on the Mac.
 */
export async function POST(req: Request) {
  const host = (req.headers.get("host") || "").toLowerCase();
  const isLocal =
    host === "" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]") ||
    host.startsWith("::1");
  if (!isLocal) {
    return NextResponse.json(
      { ok: false, error: "Her avatar launches only from this Mac (localhost)." },
      { status: 403 },
    );
  }

  // Build the path at runtime (path.join, not a static literal) so Turbopack
  // never tries to resolve it as a module.
  const dir = path.join(os.homedir(), "Desktop", "STARGATE", "starra-avatar");
  const script = path.join(dir, "main.py");
  const python = resolvePython();

  try {
    // Launch her as a proper .app so macOS grants MICROPHONE access — a detached
    // python spawn has no mic permission, so she can't hear you. The .app bundle
    // (STARRA-Avatar.app) loads XAI_API_KEY / COLAB_LIPSYNC_URL from .env.local
    // itself. Fall back to the raw python spawn if the bundle isn't installed.
    const app = path.join(os.homedir(), "Applications", "STARRA-Avatar.app");
    if (fs.existsSync(app)) {
      const child = spawn("open", ["-na", app], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return NextResponse.json({ ok: true, app });
    }
    let out: number | "ignore" = "ignore";
    try {
      out = fs.openSync(path.join(dir, "avatar.log"), "a");
    } catch {
      out = "ignore";
    }
    const child = spawn(python, [script], {
      cwd: dir,
      detached: true, // outlives this request
      stdio: ["ignore", out, out],
      env: { ...process.env, STARRA_ENGINE: process.env.STARRA_ENGINE || "viseme" },
    });
    child.on("error", () => {});
    child.unref();
    // The child inherited its own copy of the log fd at spawn time — close ours
    // now so repeated launches don't leak file descriptors in this long-running
    // server process.
    if (out !== "ignore") {
      try {
        fs.closeSync(out);
      } catch {
        /* already closed */
      }
    }
    return NextResponse.json({ ok: true, pid: child.pid ?? null, python });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "launch failed" },
      { status: 500 },
    );
  }
}
