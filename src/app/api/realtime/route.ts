export const runtime = "nodejs";

/** Issues a Realtime client secret when OPENAI_API_KEY is set; otherwise stub. */
export async function POST() {
  const key = process.env.OPENAI_API_KEY;
  const model =
    process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";

  if (!key) {
    return Response.json({
      mode: "stub",
      message: "VOICE LINK UNAVAILABLE",
    });
  }

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice: "ash",
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return Response.json(
        { mode: "error", message: err.slice(0, 200) },
        { status: 502 },
      );
    }
    const data = await res.json();
    return Response.json({ mode: "live", ...data });
  } catch (e) {
    return Response.json(
      {
        mode: "error",
        message: e instanceof Error ? e.message : "realtime failed",
      },
      { status: 502 },
    );
  }
}
