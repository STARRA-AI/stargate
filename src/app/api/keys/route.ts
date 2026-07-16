import { KEY_SLOTS, getKeys, mask, setKeys } from "@/lib/keys";

export const runtime = "nodejs";

export async function GET() {
  const store = await getKeys();
  return Response.json({
    slots: KEY_SLOTS.map((s) => ({
      id: s.id,
      label: s.label,
      hint: s.hint,
      powers: s.powers,
      linked: Boolean(store[s.id]),
      masked: store[s.id] ? mask(store[s.id]!) : null,
    })),
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, string>;
  await setKeys(body);
  return Response.json({ ok: true });
}
