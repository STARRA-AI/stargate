"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { HudState } from "@/lib/tokens";
import { statusForState } from "@/lib/copy";

export type ActionLogEntry = {
  id: string;
  time: string;
  text: string;
};

export type ConnectorStatus = "connected" | "available" | "error";

export type Connector = {
  id: string;
  name: string;
  status: ConnectorStatus;
};

export type SnapStats = {
  mrrLabel: string;
  tasksDue: number;
  pipelineOpen: number;
  working: number;
  summaries: number;
  archival: number;
};

type StargateContextValue = {
  hudState: HudState;
  setHudState: (s: HudState) => void;
  statusLine: string;
  lastReply: string;
  setLastReply: (t: string) => void;
  actionLog: ActionLogEntry[];
  pushLog: (text: string) => void;
  connectors: Connector[];
  snap: SnapStats;
  setSnap: (s: SnapStats | ((prev: SnapStats) => SnapStats)) => void;
  toolName?: string;
  setToolName: (n?: string) => void;
  bootDone: boolean;
  setBootDone: (v: boolean) => void;
};

const StargateContext = createContext<StargateContextValue | null>(null);

function nowStamp() {
  const d = new Date();
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DEFAULT_CONNECTORS: Connector[] = [
  { id: "ollama", name: "Ollama R1", status: "connected" },
  { id: "repomix", name: "Repomix", status: "connected" },
  { id: "openmontage", name: "OpenMontage", status: "available" },
  { id: "prompts", name: "Prompt Structure", status: "connected" },
  { id: "calendar", name: "Calendar", status: "available" },
  { id: "gmail", name: "Gmail", status: "available" },
];

const DEFAULT_SNAP: SnapStats = {
  mrrLabel: "—",
  tasksDue: 0,
  pipelineOpen: 0,
  working: 0,
  summaries: 0,
  archival: 0,
};

export function StargateProvider({ children }: { children: ReactNode }) {
  const [hudState, setHudState] = useState<HudState>("idle");
  const [lastReply, setLastReply] = useState("");
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([
    { id: "1", time: nowStamp(), text: "[SCAN] Dragon Tradar uplink handshake OK" },
    { id: "2", time: nowStamp(), text: "[ORACLE] Think Tank consensus refreshed — 4/4 LONG" },
    { id: "3", time: nowStamp(), text: "[THNK] Proposal queue: 3 awaiting operator" },
    { id: "4", time: nowStamp(), text: "[EXEC] STARGATE kernel online — standing by" },
    { id: "5", time: nowStamp(), text: "[REPO] Working tree clean" },
  ]);
  const [connectors] = useState<Connector[]>(DEFAULT_CONNECTORS);
  const [snap, setSnap] = useState<SnapStats>(DEFAULT_SNAP);
  const [toolName, setToolName] = useState<string | undefined>();
  const [bootDone, setBootDone] = useState(false);

  const pushLog = useCallback((text: string) => {
    setActionLog((prev) => [
      { id: `${Date.now()}`, time: nowStamp(), text },
      ...prev,
    ].slice(0, 40));
  }, []);

  const statusLine = useMemo(
    () => statusForState(hudState, toolName),
    [hudState, toolName],
  );

  const value = useMemo(
    () => ({
      hudState,
      setHudState,
      statusLine,
      lastReply,
      setLastReply,
      actionLog,
      pushLog,
      connectors,
      snap,
      setSnap,
      toolName,
      setToolName,
      bootDone,
      setBootDone,
    }),
    [
      hudState,
      statusLine,
      lastReply,
      actionLog,
      pushLog,
      connectors,
      snap,
      toolName,
      bootDone,
    ],
  );

  return (
    <StargateContext.Provider value={value}>{children}</StargateContext.Provider>
  );
}

export function useStargate() {
  const ctx = useContext(StargateContext);
  if (!ctx) throw new Error("useStargate must be used within StargateProvider");
  return ctx;
}
