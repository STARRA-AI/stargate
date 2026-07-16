"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import { useCallback, useEffect, useState } from "react";

type RepomixState = {
  hasPack?: boolean;
  preview?: string | null;
  outputPath?: string;
};

type MontageState = {
  present: boolean;
  path: string;
  hasVenv: boolean;
  hasRemotion: boolean;
  guide: string;
  jobs: { id: string; brief: string; status: string; at: string; pipeline: string }[];
};

type PromptsState = {
  present: boolean;
  distilled: boolean;
  structurePath: string;
  policy: string;
  structurePreview: string;
};

type MulticaState = {
  vendorPresent: boolean;
  vendorPath: string;
  cliPresent: boolean;
  cliVersion: string | null;
  tokenLinked: boolean;
  baseUrl: string;
  guide: string;
};

type MulticaWorkspace = { id: string; name: string; slug: string };
type MulticaIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  status?: string;
};

export default function ToolsPage() {
  const [repomix, setRepomix] = useState<RepomixState>({});
  const [montage, setMontage] = useState<MontageState | null>(null);
  const [prompts, setPrompts] = useState<PromptsState | null>(null);
  const [multica, setMultica] = useState<MulticaState | null>(null);
  const [workspaces, setWorkspaces] = useState<MulticaWorkspace[]>([]);
  const [issues, setIssues] = useState<MulticaIssue[]>([]);
  const [issueTitle, setIssueTitle] = useState("STARRA stub — operator follow-up");
  const [topic, setTopic] = useState("healing after her — one hard truth");
  const [status, setStatus] = useState("");
  const [packPreview, setPackPreview] = useState("");

  const refresh = useCallback(async () => {
    const [r, m, p, mu] = await Promise.all([
      fetch("/api/tools/repomix").then((x) => x.json()),
      fetch("/api/tools/openmontage").then((x) => x.json()),
      fetch("/api/tools/prompts").then((x) => x.json()),
      fetch("/api/tools/multica").then((x) => x.json()),
    ]);
    setRepomix(r);
    setMontage(m);
    setPrompts(p);
    setMultica(mu);
    if (r.preview) setPackPreview(r.preview);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function packRepo() {
    setStatus("EXECUTING — REPOMIX");
    const res = await fetch("/api/tools/repomix", { method: "POST", body: "{}" });
    const data = await res.json();
    setStatus(data.ok ? `PACKED · ${data.bytes} bytes` : `LINK DEGRADED · ${data.error}`);
    if (data.preview) setPackPreview(data.preview);
    await refresh();
  }

  async function queueMontage() {
    setStatus("EXECUTING — OPENMONTAGE QUEUE");
    const res = await fetch("/api/tools/openmontage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }),
    });
    const data = await res.json();
    setStatus(res.ok ? `QUEUED · ${data.id}` : "LINK DEGRADED. RETRY?");
    await refresh();
  }

  async function distillPrompts() {
    setStatus("EXECUTING — PROMPT DISTILL");
    const res = await fetch("/api/tools/prompts", { method: "POST" });
    const data = await res.json();
    setStatus(data.ok ? "STRUCTURE DISTILLED" : "LINK DEGRADED. RETRY?");
    await refresh();
  }

  async function loadMulticaBoard() {
    setStatus("EXECUTING — MULTICA LIST");
    const [wsRes, isRes, agRes] = await Promise.all([
      fetch("/api/tools/multica?action=workspaces").then((x) => x.json()),
      fetch("/api/tools/multica?action=issues").then((x) => x.json()),
      fetch("/api/tools/multica?action=agents").then((x) => x.json()),
    ]);
    if (wsRes.error || isRes.error) {
      setStatus(`LINK DEGRADED · ${wsRes.error ?? isRes.error}`);
      return;
    }
    setWorkspaces(wsRes.workspaces ?? []);
    setIssues(isRes.issues ?? []);
    const agentCount = Array.isArray(agRes.agents) ? agRes.agents.length : 0;
    setStatus(
      `MULTICA · ${(wsRes.workspaces ?? []).length} workspaces · ${(isRes.issues ?? []).length} issues · ${agentCount} agents`,
    );
  }

  async function createMulticaIssue() {
    setStatus("EXECUTING — MULTICA CREATE");
    const res = await fetch("/api/tools/multica", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: issueTitle }),
    });
    const data = await res.json();
    setStatus(
      res.ok
        ? `CREATED · ${data.identifier ?? data.id ?? "issue"}`
        : `LINK DEGRADED · ${data.error ?? "retry"}`,
    );
    if (res.ok) await loadMulticaBoard();
  }

  async function quickCreateMultica() {
    setStatus("EXECUTING — MULTICA QUICK");
    const res = await fetch("/api/tools/multica", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "quick", prompt: issueTitle }),
    });
    const data = await res.json();
    setStatus(
      res.ok
        ? `QUEUED · ${data.task_id ?? "run"}`
        : `LINK DEGRADED · ${data.error ?? "retry"}`,
    );
    if (res.ok) await loadMulticaBoard();
  }

  return (
    <ScreenShell title="Tools">
      {status && (
        <p className="mb-4 font-[family-name:var(--font-mono)] text-xs tracking-widest text-[var(--magenta)] uppercase">
          {status}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {/* Repomix */}
        <section className="panel-etch flex flex-col gap-3 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            Repomix
          </h2>
          <p className="font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
            Pack this codebase into an AI-readable XML dump for deep inspections.
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {repomix.hasPack ? `● pack ready · ${repomix.outputPath}` : "○ no pack yet"}
          </p>
          <button
            type="button"
            onClick={() => void packRepo()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            Pack repo
          </button>
          {packPreview && (
            <pre className="max-h-48 overflow-auto border border-[var(--border-soft)] p-2 font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
              {packPreview}
            </pre>
          )}
        </section>

        {/* OpenMontage */}
        <section className="panel-etch flex flex-col gap-3 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            OpenMontage
          </h2>
          <p className="font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
            Queue Silent Shadow / Book of Starra video briefs for the agentic studio in{" "}
            <span className="text-[var(--magenta)]">vendor/OpenMontage</span>.
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {montage?.present ? "● vendor present" : "○ run npm run tools:bootstrap"} ·{" "}
            {montage?.hasVenv ? "venv ok" : "venv missing"} ·{" "}
            {montage?.hasRemotion ? "remotion ok" : "remotion not installed"}
          </p>
          <label className="font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
            Topic
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-xs normal-case tracking-normal text-[var(--chrome)]"
            />
          </label>
          <button
            type="button"
            onClick={() => void queueMontage()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            Queue Silent Shadow short
          </button>
          <ul className="max-h-40 space-y-2 overflow-auto font-[family-name:var(--font-mono)] text-[10px] text-[var(--chrome)]">
            {(montage?.jobs ?? []).slice(0, 5).map((j) => (
              <li key={j.id} className="border-b border-[var(--border-soft)] pb-1">
                {j.id} · {j.status} · {j.pipeline}
              </li>
            ))}
          </ul>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {montage?.guide}
          </p>
        </section>

        {/* Prompts */}
        <section className="panel-etch flex flex-col gap-3 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            Prompt structure
          </h2>
          <p className="font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
            Distill section patterns from system_prompts_leaks into STARRA scaffold. Tone stays operator.
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {prompts?.present ? "● leaks clone present" : "○ missing clone"} ·{" "}
            {prompts?.distilled ? "distilled" : "not distilled"}
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--magenta)]">
            {prompts?.policy}
          </p>
          <button
            type="button"
            onClick={() => void distillPrompts()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            Re-distill
          </button>
          {prompts?.structurePreview && (
            <pre className="max-h-48 overflow-auto border border-[var(--border-soft)] p-2 font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
              {prompts.structurePreview}
            </pre>
          )}
        </section>

        {/* Multica */}
        <section className="panel-etch flex flex-col gap-3 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            Multica
          </h2>
          <p className="font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
            Agents as teammates — workspaces, issues, skills. External muscle for STARRA.
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {multica?.vendorPresent ? "● vendor present" : "○ run bootstrap-multica"} ·{" "}
            {multica?.cliPresent
              ? `cli ${multica.cliVersion ?? "ok"}`
              : "cli missing"} ·{" "}
            {multica?.tokenLinked ? "token linked" : "○ link PAT in Settings"}
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--magenta)]">
            {multica?.baseUrl}
          </p>
          <button
            type="button"
            onClick={() => void loadMulticaBoard()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            List workspaces / issues
          </button>
          <label className="font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
            Issue title
            <input
              value={issueTitle}
              onChange={(e) => setIssueTitle(e.target.value)}
              className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-xs normal-case tracking-normal text-[var(--chrome)]"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void createMulticaIssue()}
              className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
            >
              Create issue stub
            </button>
            <button
              type="button"
              onClick={() => void quickCreateMultica()}
              className="focus-magenta border border-[var(--magenta)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
            >
              Quick-create + enqueue
            </button>
          </div>
          <ul className="max-h-24 space-y-1 overflow-auto font-[family-name:var(--font-mono)] text-[10px] text-[var(--chrome)]">
            {workspaces.slice(0, 5).map((w) => (
              <li key={w.id}>
                ws · {w.slug || w.name}
              </li>
            ))}
            {issues.slice(0, 5).map((i) => (
              <li key={i.id ?? i.identifier ?? i.title}>
                {i.identifier ?? i.id} · {i.status ?? "—"} · {i.title}
              </li>
            ))}
          </ul>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {multica?.guide}
          </p>
        </section>
      </div>
    </ScreenShell>
  );
}
