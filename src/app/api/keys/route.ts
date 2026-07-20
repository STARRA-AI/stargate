import { KEY_SLOTS, getKey, mask, setKeys } from "@/lib/keys";

export const runtime = "nodejs";

export async function GET() {
  // Resolve each slot through getKey so keys provided via .env (not just the
  // vault file) correctly show as linked — matches what the app actually uses.
  const slots = await Promise.all(
    KEY_SLOTS.map(async (s) => {
      const val = await getKey(s.id);
      return {
        id: s.id,
        label: s.label,
        hint: s.hint,
        powers: s.powers,
        linked: Boolean(val),
        masked: val ? mask(val) : null,
      };
    }),
  );
  return Response.json({ slots });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "body must be an object" }, { status: 400 });
  }
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return Response.json(
        { error: "all key values must be strings" },
        { status: 400 },
      );
    }
  }
  await setKeys(body as Record<string, string>);
  return Response.json({ ok: true });
}
