import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

/**
 * ROUTINES (G11) — state store + toggle API for the settings table.
 * STUB SCOPE (pending the integrations division): toggling records intent
 * only; no launchd job is installed by this route, ever. Scheduler
 * installation is a separate script Classic runs himself.
 */

export type RoutineId = "nightly-distill" | "morning-brief-prep" | "weekly-ops-report";
export type Routine = {
  id: RoutineId;
  label: string;
  schedule: string;
  enabled: boolean;
  lastRun: string | null;
  lastResult: string | null;
};

const STORE = path.join(process.cwd(), "data", "routines.json");

const DEFAULTS: Routine[] = [
  {
    id: "nightly-distill",
    label: "Nightly distill",
    schedule: "2:00am daily",
    enabled: false,
    lastRun: null,
    lastResult: null,
  },
  {
    id: "morning-brief-prep",
    label: "Morning brief prep",
    schedule: "6:45am daily",
    enabled: false,
    lastRun: null,
    lastResult: null,
  },
  {
    id: "weekly-ops-report",
    label: "Weekly ops report",
    schedule: "Sun 8:00pm",
    enabled: false,
    lastRun: null,
    lastResult: null,
  },
];

function readRoutines(): Routine[] {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8")) as { routines?: Routine[] };
    const byId = new Map((raw.routines ?? []).map((r) => [r.id, r]));
    // Defaults are the schema of record; stored rows only carry state.
    return DEFAULTS.map((d) => ({ ...d, ...(byId.get(d.id) ?? {}) }));
  } catch {
    return DEFAULTS;
  }
}

function writeRoutines(routines: Routine[]): void {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify({ routines }, null, 2));
}

export async function GET() {
  return Response.json({ routines: readRoutines() });
}

export async function PUT(req: Request) {
  const body = (await req.json()) as { id?: string; enabled?: boolean };
  const routines = readRoutines();
  const target = routines.find((r) => r.id === body.id);
  if (target && typeof body.enabled === "boolean") {
    target.enabled = body.enabled;
    writeRoutines(routines);
  }
  return Response.json({ routines });
}
