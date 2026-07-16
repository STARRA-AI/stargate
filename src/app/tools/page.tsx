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
  hasGuide?: boolean;
  ready?: boolean;
  readiness?: string;
  retiredPath?: string;
  guide: string;
  nextStep?: string;
  pipelines?: string[];
  jobs: {
    id: string;
    brief: string;
    status: string;
    at: string;
    pipeline: string;
    outputPath?: string;
  }[];
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

type OpenAliceState = {
  vendorPresent: boolean;
  vendorPath: string;
  vendorVersion: string | null;
  runtimeUrl: string;
  runtimeReachable: boolean;
  runtimeVersion: string | null;
  tradingAvailable: boolean | null;
  tradingMode: string | null;
  executionGate: string;
  brokerKeysLinked: boolean;
  guide: string;
};

type OpenAliceIssue = {
  wsId?: string;
  id?: string;
  title?: string;
  status?: string;
};

type OpenAliceInboxEntry = {
  id?: string;
  title?: string;
  preview?: string;
};

type FundingSource = {
  id: string;
  repo: string;
  name: string;
  url: string;
  domain: string;
  kind: string;
  fit: "accepted" | "future_hook" | "rejected";
  access: string;
  summary: string;
  useNow: string;
  reason: string;
  operatorActions: string[];
  futureHooks: string[];
};

type FundingState = {
  registry: FundingSource[];
  summary: {
    counts: {
      total: number;
      acceptedNow: number;
      futureHooks: number;
      rejected: number;
    };
  };
  keyHooks: { id: string; label: string; linked: boolean }[];
  stance: string;
};

type ObsidianState = {
  present: boolean;
  vaultRootRel: string;
  noteCount: number;
  folders: { name: string; present: boolean }[];
  skillsVendorPresent: boolean;
  guide: string;
  layers: {
    longTermMemory: string;
    assistant: string;
    backupSync: string;
  };
};

type ObsidianNote = {
  rel: string;
  title: string;
  bytes: number;
  mtime: string;
};

export default function ToolsPage() {
  const [repomix, setRepomix] = useState<RepomixState>({});
  const [montage, setMontage] = useState<MontageState | null>(null);
  const [prompts, setPrompts] = useState<PromptsState | null>(null);
  const [multica, setMultica] = useState<MulticaState | null>(null);
  const [openalice, setOpenalice] = useState<OpenAliceState | null>(null);
  const [funding, setFunding] = useState<FundingState | null>(null);
  const [obsidian, setObsidian] = useState<ObsidianState | null>(null);
  const [vaultNotes, setVaultNotes] = useState<ObsidianNote[]>([]);
  const [vaultQuery, setVaultQuery] = useState("");
  const [vaultSearchHits, setVaultSearchHits] = useState<
    { rel: string; snippet: string; line: number }[]
  >([]);
  const [notePath, setNotePath] = useState("0-Inbox/Capture.md");
  const [noteContent, setNoteContent] = useState(
    "# Capture\n\n[[Inbox]] — note from Tools.\n",
  );
  const [confirmToken, setConfirmToken] = useState("");
  const [workspaces, setWorkspaces] = useState<MulticaWorkspace[]>([]);
  const [issues, setIssues] = useState<MulticaIssue[]>([]);
  const [aliceIssues, setAliceIssues] = useState<OpenAliceIssue[]>([]);
  const [aliceInbox, setAliceInbox] = useState<OpenAliceInboxEntry[]>([]);
  const [researchQuery, setResearchQuery] = useState("sector rotation scan");
  const [researchPlan, setResearchPlan] = useState("");
  const [issueTitle, setIssueTitle] = useState("STARRA stub — operator follow-up");
  const [topic, setTopic] = useState("healing after her — one hard truth");
  const [montagePipeline, setMontagePipeline] = useState("silent-shadow-short");
  const [status, setStatus] = useState("");
  const [packPreview, setPackPreview] = useState("");

  const refresh = useCallback(async () => {
    const [r, m, p, mu, oa, f, ob] = await Promise.all([
      fetch("/api/tools/repomix").then((x) => x.json()),
      fetch("/api/tools/openmontage").then((x) => x.json()),
      fetch("/api/tools/prompts").then((x) => x.json()),
      fetch("/api/tools/multica").then((x) => x.json()),
      fetch("/api/tools/openalice").then((x) => x.json()),
      fetch("/api/tools/funding").then((x) => x.json()),
      fetch("/api/tools/obsidian?action=status").then((x) => x.json()),
    ]);
    setRepomix(r);
    setMontage(m);
    setPrompts(p);
    setMultica(mu);
    setOpenalice(oa);
    setFunding(f);
    setObsidian(ob);
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
      body: JSON.stringify({ topic, pipeline: montagePipeline }),
    });
    const data = await res.json();
    setStatus(res.ok ? `QUEUED · ${data.id}` : "LINK DEGRADED. RETRY?");
    await refresh();
  }

  async function markMontageDone(id: string) {
    setStatus("EXECUTING — MARK RENDER DONE");
    const res = await fetch("/api/tools/openmontage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_done", id }),
    });
    setStatus(res.ok ? `DONE · ${id}` : "LINK DEGRADED. RETRY?");
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

  async function loadOpenAliceIntel() {
    setStatus("EXECUTING — OPENALICE LIST");
    const [isRes, inRes] = await Promise.all([
      fetch("/api/tools/openalice?action=issues").then((x) => x.json()),
      fetch("/api/tools/openalice?action=inbox").then((x) => x.json()),
    ]);
    if (isRes.error && inRes.error) {
      setStatus(`LINK DEGRADED · ${isRes.error ?? inRes.error}`);
      return;
    }
    setAliceIssues(isRes.issues ?? []);
    setAliceInbox(inRes.entries ?? []);
    setStatus(
      `OPENALICE · ${(isRes.issues ?? []).length} issues · ${(inRes.entries ?? []).length} inbox`,
    );
  }

  async function planOpenAliceResearch() {
    setStatus("EXECUTING — OPENALICE PLAN");
    const res = await fetch(
      `/api/tools/openalice?action=plan&q=${encodeURIComponent(researchQuery)}`,
    );
    const data = await res.json();
    if (!res.ok) {
      setStatus(`LINK DEGRADED · ${data.error ?? "retry"}`);
      return;
    }
    setResearchPlan(
      `${data.readout}\n\n${data.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\n${data.executionNote}`,
    );
    setStatus(`PLAN · ${data.query}`);
  }

  async function initVault() {
    setStatus("EXECUTING — VAULT INIT");
    const res = await fetch("/api/tools/obsidian", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "init" }),
    });
    const data = await res.json();
    setStatus(
      res.ok
        ? `VAULT · ${data.alreadyPresent ? "ready" : `created ${data.created?.length ?? 0}`}`
        : `LINK DEGRADED · ${data.error ?? "retry"}`,
    );
    await refresh();
  }

  async function listVaultNotes() {
    setStatus("EXECUTING — VAULT LIST");
    const res = await fetch("/api/tools/obsidian?action=list");
    const data = await res.json();
    if (!res.ok) {
      setStatus(`LINK DEGRADED · ${data.error ?? "retry"}`);
      return;
    }
    setVaultNotes(data.notes ?? []);
    setStatus(`VAULT · ${(data.notes ?? []).length} notes`);
  }

  async function searchVault() {
    setStatus("EXECUTING — VAULT SEARCH");
    const res = await fetch(
      `/api/tools/obsidian?action=search&q=${encodeURIComponent(vaultQuery)}`,
    );
    const data = await res.json();
    if (!res.ok) {
      setStatus(`LINK DEGRADED · ${data.error ?? "retry"}`);
      return;
    }
    setVaultSearchHits(data.hits ?? []);
    setStatus(`HITS · ${(data.hits ?? []).length}`);
  }

  async function writeVaultNote(mode: "create" | "append" | "overwrite") {
    setStatus(`EXECUTING — VAULT ${mode.toUpperCase()}`);
    const res = await fetch("/api/tools/obsidian", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "write",
        path: notePath,
        content: noteContent,
        mode,
        confirmToken: confirmToken || undefined,
      }),
    });
    const data = await res.json();
    if (res.status === 428 && data.token) {
      setConfirmToken(data.token);
      setStatus(`HELD · confirm ${data.token}`);
      return;
    }
    setStatus(
      res.ok
        ? `${mode.toUpperCase()} · ${data.rel}`
        : `LINK DEGRADED · ${data.error ?? "retry"}`,
    );
    if (res.ok) {
      setConfirmToken("");
      await listVaultNotes();
      await refresh();
    }
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

        {/* OpenMontage — canonical video path */}
        <section className="panel-etch flex flex-col gap-3 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            OpenMontage
          </h2>
          <p className="font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
            Canonical video studio for Silent Shadow Shorts and Book of Starra. Queue a brief;
            an agent renders via{" "}
            <span className="text-[var(--magenta)]">AGENT_GUIDE.md</span>. Higgsfield is retired —
            do not rewire it.
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {montage?.ready ? "● READY" : "○ NOT READY"} ·{" "}
            {montage?.present ? "vendor" : "run tools:bootstrap"} ·{" "}
            {montage?.hasVenv ? "venv" : "venv missing"} ·{" "}
            {montage?.hasRemotion ? "remotion" : "remotion missing"}
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--chrome)]">
            NEXT: {montage?.nextStep ?? "Run: npm run tools:bootstrap"}
          </p>
          <label className="font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
            Pipeline
            <select
              value={montagePipeline}
              onChange={(e) => setMontagePipeline(e.target.value)}
              className="focus-magenta mt-1 w-full border border-[var(--border)] bg-[var(--void)] px-2 py-1 text-xs normal-case tracking-normal text-[var(--chrome)]"
            >
              {(montage?.pipelines ?? [
                "silent-shadow-short",
                "book-of-starra",
                "atelier",
              ]).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
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
            Queue brief
          </button>
          <ul className="max-h-40 space-y-2 overflow-auto font-[family-name:var(--font-mono)] text-[10px] text-[var(--chrome)]">
            {(montage?.jobs ?? []).slice(0, 5).map((j) => (
              <li
                key={j.id}
                className="flex items-start justify-between gap-2 border-b border-[var(--border-soft)] pb-1"
              >
                <span>
                  {j.id} · {j.status} · {j.pipeline}
                  {j.outputPath ? ` · ${j.outputPath}` : ""}
                </span>
                {j.status !== "done" && j.status !== "error" ? (
                  <button
                    type="button"
                    onClick={() => void markMontageDone(j.id)}
                    className="shrink-0 border border-[var(--border)] px-1 py-0.5 text-[9px] tracking-widest uppercase text-[var(--star)]"
                  >
                    Mark done
                  </button>
                ) : null}
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

        {/* OpenAlice */}
        <section className="panel-etch flex flex-col gap-3 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            OpenAlice
          </h2>
          <p className="font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
            Alice market intel — research, issues, inbox readout. Trade execution stays gated in OpenAlice.
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {openalice?.vendorPresent ? "● vendor present" : "○ run bootstrap-openalice"} ·{" "}
            {openalice?.runtimeReachable
              ? `runtime ${openalice.runtimeVersion ?? "ok"}`
              : "runtime offline"} ·{" "}
            gate · {openalice?.executionGate ?? "—"}
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--magenta)]">
            {openalice?.runtimeUrl}
          </p>
          <button
            type="button"
            onClick={() => void loadOpenAliceIntel()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            List issues / inbox
          </button>
          <label className="font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
            Research query
            <input
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-xs normal-case tracking-normal text-[var(--chrome)]"
            />
          </label>
          <button
            type="button"
            onClick={() => void planOpenAliceResearch()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            Build research plan
          </button>
          <ul className="max-h-24 space-y-1 overflow-auto font-[family-name:var(--font-mono)] text-[10px] text-[var(--chrome)]">
            {aliceIssues.slice(0, 5).map((i) => (
              <li key={`${i.wsId ?? "ws"}-${i.id ?? i.title}`}>
                {i.id ?? "issue"} · {i.status ?? "—"} · {i.title}
              </li>
            ))}
            {aliceInbox.slice(0, 3).map((e) => (
              <li key={e.id ?? e.title ?? e.preview}>
                inbox · {e.title ?? e.preview?.slice(0, 48) ?? "—"}
              </li>
            ))}
          </ul>
          {researchPlan && (
            <pre className="max-h-36 overflow-auto border border-[var(--border-soft)] p-2 font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)] whitespace-pre-wrap">
              {researchPlan}
            </pre>
          )}
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
            {openalice?.guide}
          </p>
        </section>
      </div>

      <section className="panel-etch mt-4 space-y-4 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
              Memory / Vault
            </h2>
            <p className="mt-2 max-w-3xl font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
              Three layers: local Obsidian markdown (long-term), STARRA grammar +
              gated note ops (assistant), private Git sync (backup). Never into
              the app repo.
            </p>
          </div>
          <div className="ml-auto grid min-w-56 gap-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)] uppercase">
            <span>
              {obsidian?.present ? "● vault online" : "○ vault missing"} ·{" "}
              {obsidian?.noteCount ?? 0} notes
            </span>
            <span>path · {obsidian?.vaultRootRel ?? "data/vault"}</span>
            <span>
              skills ·{" "}
              {obsidian?.skillsVendorPresent ? "vendor present" : "optional clone"}
            </span>
          </div>
        </div>

        <div className="grid gap-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--chrome)] md:grid-cols-3">
          <p>
            <span className="text-[var(--magenta)] uppercase tracking-widest text-[10px]">
              L1 memory
            </span>
            <br />
            {obsidian?.layers.longTermMemory ?? "—"}
          </p>
          <p>
            <span className="text-[var(--magenta)] uppercase tracking-widest text-[10px]">
              L2 assistant
            </span>
            <br />
            {obsidian?.layers.assistant ?? "—"}
          </p>
          <p>
            <span className="text-[var(--magenta)] uppercase tracking-widest text-[10px]">
              L3 backup
            </span>
            <br />
            {obsidian?.layers.backupSync ?? "—"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void initVault()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            Init vault
          </button>
          <button
            type="button"
            onClick={() => void listVaultNotes()}
            className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
          >
            List notes
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <label className="block font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
              Search
              <div className="mt-1 flex gap-2">
                <input
                  value={vaultQuery}
                  onChange={(e) => setVaultQuery(e.target.value)}
                  className="focus-magenta w-full border border-[var(--border)] bg-transparent px-2 py-1 text-xs normal-case tracking-normal text-[var(--chrome)]"
                />
                <button
                  type="button"
                  onClick={() => void searchVault()}
                  className="focus-magenta border border-[var(--purple)] px-3 py-1 font-[family-name:var(--font-display)] text-[10px] tracking-[0.2em] uppercase"
                >
                  Go
                </button>
              </div>
            </label>
            <ul className="max-h-36 space-y-1 overflow-auto font-[family-name:var(--font-mono)] text-[10px] text-[var(--chrome)]">
              {vaultSearchHits.map((h) => (
                <li key={`${h.rel}-${h.line}`}>
                  {h.rel}:{h.line} · {h.snippet}
                </li>
              ))}
              {vaultNotes.slice(0, 12).map((n) => (
                <li key={n.rel}>
                  {n.rel} · {n.bytes}b
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-3">
            <label className="block font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
              Path
              <input
                value={notePath}
                onChange={(e) => setNotePath(e.target.value)}
                className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-xs normal-case tracking-normal text-[var(--chrome)]"
              />
            </label>
            <label className="block font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
              Content
              <textarea
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                rows={5}
                className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-xs normal-case tracking-normal text-[var(--chrome)]"
              />
            </label>
            {confirmToken ? (
              <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--magenta)]">
                Confirm token · {confirmToken} — re-run overwrite to apply
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void writeVaultNote("create")}
                className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => void writeVaultNote("append")}
                className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
              >
                Append
              </button>
              <button
                type="button"
                onClick={() => void writeVaultNote("overwrite")}
                className="focus-magenta border border-[var(--magenta)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
              >
                Overwrite (gated)
              </button>
            </div>
          </div>
        </div>

        <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
          {obsidian?.guide} · docs/OBSIDIAN_MEMORY.md · npm run vault:sync
        </p>
      </section>

      <section className="panel-etch mt-4 space-y-4 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
              Funding intel
            </h2>
            <p className="mt-2 max-w-3xl font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
              {funding?.stance ??
                "Normalizing public funding sources into operator-ready registry entries."}
            </p>
          </div>
          <div className="ml-auto grid min-w-56 gap-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)] uppercase">
            <span>sources · {funding?.summary.counts.total ?? "—"}</span>
            <span>usable now · {funding?.summary.counts.acceptedNow ?? "—"}</span>
            <span>future hooks · {funding?.summary.counts.futureHooks ?? "—"}</span>
            <span>excluded · {funding?.summary.counts.rejected ?? "—"}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 font-[family-name:var(--font-mono)] text-[10px] uppercase">
          {(funding?.keyHooks ?? []).map((hook) => (
            <span
              key={hook.id}
              className={`border px-2 py-1 ${
                hook.linked
                  ? "border-[var(--ok)] text-[var(--ok)]"
                  : "border-[var(--border)] text-[var(--star)]"
              }`}
            >
              {hook.linked ? "●" : "○"} {hook.label}
            </span>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          {(funding?.registry ?? []).map((source) => (
            <article key={source.id} className="border border-[var(--border-soft)] p-4">
              <div className="flex items-start gap-2">
                <div>
                  <h3 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.24em] text-[var(--chrome)] uppercase">
                    {source.name}
                  </h3>
                  <p className="mt-1 font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--star)] uppercase">
                    {source.repo}
                  </p>
                </div>
                <span
                  className={`ml-auto font-[family-name:var(--font-mono)] text-[10px] tracking-widest uppercase ${
                    source.fit === "accepted"
                      ? "text-[var(--ok)]"
                      : source.fit === "future_hook"
                        ? "text-[var(--magenta)]"
                        : "text-[var(--danger)]"
                  }`}
                >
                  {source.fit === "accepted"
                    ? "LIVE NOW"
                    : source.fit === "future_hook"
                      ? "HOOK LATER"
                      : "EXCLUDED"}
                </span>
              </div>

              <p className="mt-3 font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--chrome)]">
                {source.summary}
              </p>
              <p className="mt-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--magenta)]">
                USE NOW: {source.useNow}
              </p>
              <p className="mt-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--star)]">
                WHY: {source.reason}
              </p>

              <div className="mt-3 flex flex-wrap gap-2 font-[family-name:var(--font-mono)] text-[10px] uppercase">
                <span className="border border-[var(--border)] px-2 py-1 text-[var(--star)]">
                  {source.kind.replaceAll("_", " ")}
                </span>
                <span className="border border-[var(--border)] px-2 py-1 text-[var(--star)]">
                  {source.domain.replaceAll("_", " ")}
                </span>
                <span className="border border-[var(--border)] px-2 py-1 text-[var(--star)]">
                  access · {source.access.replaceAll("_", " ")}
                </span>
              </div>

              <ul className="mt-3 space-y-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--chrome)]">
                {source.operatorActions.map((action) => (
                  <li key={action}>◆ {action}</li>
                ))}
              </ul>

              <div className="mt-4 flex items-center gap-3">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-magenta border border-[var(--purple)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
                >
                  Open source
                </a>
                {source.futureHooks.length > 0 ? (
                  <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)] uppercase">
                    hooks · {source.futureHooks.join(" · ")}
                  </span>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </ScreenShell>
  );
}
