/**
 * Server-side Agent Ops feed — one line per real system event
 * (chat, tool calls, market refresh, proposal decisions).
 */

export type FeedLine = {
  id: string;
  time: string;
  tag: string;
  color: string;
  text: string;
};

const TAG_COLORS: Record<string, string> = {
  EXEC: "#d38bff",
  ORACLE: "#6ee7a0",
  SCAN: "#7dd3fc",
  THNK: "#ffd166",
  SYS: "#b79fe0",
  REPO: "#ff6b8a",
  LINK: "#ffd166",
};

const g = globalThis as unknown as { __stargateFeed?: FeedLine[] };

function feed(): FeedLine[] {
  if (!g.__stargateFeed) {
    g.__stargateFeed = [];
    pushFeed("SYS", "STARGATE kernel online — feed live");
  }
  return g.__stargateFeed;
}

export function pushFeed(tag: string, text: string) {
  const list = g.__stargateFeed ?? (g.__stargateFeed = []);
  list.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }),
    tag: `[${tag}]`,
    color: TAG_COLORS[tag] ?? TAG_COLORS.SYS,
    text,
  });
  if (list.length > 60) list.length = 60;
}

export function readFeed(): FeedLine[] {
  return feed();
}
