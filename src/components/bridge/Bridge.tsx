"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { COPY } from "@/lib/copy";
import { fmtMoney } from "@/lib/deck-demo";
import { useStargate } from "@/lib/stargate-context";
import { useVoiceLoop } from "@/lib/voice/useVoiceLoop";
import { DeckBoot } from "./DeckBoot";
import { DeckConsole } from "./DeckConsole";
import { ReactorEye } from "./ReactorEye";
import { useStageScale } from "./useStageScale";
import "@/styles/deck.css";

/* ── live data shapes from the API layer ── */

type Vitals = { cpu: number; mem: number; tokens: number; uptime_seconds: number };

type WatchMarket = {
  ticker: string;
  title: string;
  subtitle: string;
  lastCents: number;
  volume: number;
};

type Portfolio = {
  linked: boolean;
  balanceDollars?: number;
  positions?: { ticker: string; side: "YES" | "NO"; quantity: number; exposureDollars: number }[];
  error?: string;
};

type TankVote = { name: string; vote: string; conf: number };

type Telemetry = {
  up: boolean;
  latencyMs: number;
  uptimePct: string;
  samples: number;
  stats: Record<string, unknown> | null;
  statsLinked: boolean;
};

type Proposal = { id: number; tag: string; text: string; impact: string };
type Venture = { name: string; status: string; color: string };

type FeedLine = { id: string; time: string; tag: string; color: string; text: string };

function fmtUptime(totalSec: number) {
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function voteColor(vote: string) {
  if (vote === "LONG") return "var(--good)";
  if (vote === "SHORT") return "var(--bad)";
  if (vote === "LINK") return "var(--text-faint)";
  return "var(--warn)";
}

function useInterval(fn: () => void, ms: number, label?: string) {
  useEffect(() => {
    let fails = 0;
    let oks = 0;
    const wrapped = () => {
      const t0 = Date.now();
      try {
        fn();
        oks += 1;
      } catch {
        fails += 1;
      }
      // #region agent log
      if (label && (oks + fails) % 3 === 1) {
        fetch(
          "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "f8c9f7",
            },
            body: JSON.stringify({
              sessionId: "f8c9f7",
              location: "Bridge.tsx:useInterval",
              message: "deck poll tick",
              data: { label, ms, oks, fails, t0 },
              timestamp: Date.now(),
              hypothesisId: "H-D1",
              runId: "pre",
            }),
          },
        ).catch(() => {});
      }
      // #endregion
    };
    wrapped();
    const id = setInterval(wrapped, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
}

export function Bridge() {
  const { statusLine, setBootDone, bootDone, hudState } = useStargate();
  const { wake } = useVoiceLoop();
  const stageRef = useStageScale();

  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [watchlist, setWatchlist] = useState<WatchMarket[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio>({ linked: false });
  const [tank, setTank] = useState<TankVote[]>([]);
  const [tankTopic, setTankTopic] = useState("");
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [clock, setClock] = useState("—");
  const [eco, setEco] = useState(false);

  const onBootDone = useCallback(() => setBootDone(true), [setBootDone]);
  const onMic = useCallback(() => {
    void wake();
  }, [wake]);

  useEffect(() => {
    document.documentElement.classList.add("deck-active");
    return () => document.documentElement.classList.remove("deck-active");
  }, []);

  useEffect(() => {
    document.body.classList.toggle("low-power", eco);
  }, [eco]);

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* ── live polling ── */

  /* Poll rates: vitals/feed slightly relaxed under memory pressure (99% observed) */
  useInterval(() => {
    fetch("/api/vitals")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(setVitals)
      .catch(() => {
        // #region agent log
        fetch(
          "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "f8c9f7",
            },
            body: JSON.stringify({
              sessionId: "f8c9f7",
              location: "Bridge.tsx:vitals",
              message: "vitals fetch failed",
              data: {},
              timestamp: Date.now(),
              hypothesisId: "H-D2",
              runId: "pre",
            }),
          },
        ).catch(() => {});
        // #endregion
      });
  }, 8000, "vitals");

  useInterval(() => {
    fetch("/api/dragon")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: { watchlist: WatchMarket[]; portfolio: Portfolio }) => {
        setWatchlist(d.watchlist ?? []);
        setPortfolio(d.portfolio ?? { linked: false });
        // #region agent log
        fetch(
          "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "f8c9f7",
            },
            body: JSON.stringify({
              sessionId: "f8c9f7",
              location: "Bridge.tsx:dragon",
              message: "dragon poll ok",
              data: {
                watchCount: (d.watchlist ?? []).length,
                portfolioLinked: Boolean(d.portfolio?.linked),
              },
              timestamp: Date.now(),
              hypothesisId: "H-D2",
              runId: "pre",
            }),
          },
        ).catch(() => {});
        // #endregion
      })
      .catch(() => {});
  }, 60_000, "dragon");

  useInterval(() => {
    fetch("/api/tank")
      .then((r) => r.json())
      .then((d: { votes: TankVote[]; topic: string }) => {
        setTank(d.votes ?? []);
        setTankTopic(d.topic ?? "");
        const linkCount = (d.votes ?? []).filter((v) => v.vote === "LINK").length;
        // #region agent log
        fetch(
          "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "f8c9f7",
            },
            body: JSON.stringify({
              sessionId: "f8c9f7",
              location: "Bridge.tsx:tank",
              message: "tank poll",
              data: { votes: d.votes?.length ?? 0, linkCount, topic: (d.topic ?? "").slice(0, 60) },
              timestamp: Date.now(),
              hypothesisId: "H-D3",
              runId: "pre",
            }),
          },
        ).catch(() => {});
        // #endregion
      })
      .catch(() => {});
  }, 45_000, "tank");

  useInterval(() => {
    fetch("/api/telemetry")
      .then((r) => r.json())
      .then(setTelemetry)
      .catch(() => {});
  }, 45_000, "telemetry");

  useInterval(() => {
    fetch("/api/proposals")
      .then((r) => r.json())
      .then((d: { proposals: Proposal[]; ventures: Venture[] }) => {
        setProposals(d.proposals ?? []);
        setVentures(d.ventures ?? []);
      })
      .catch(() => {});
  }, 60_000, "proposals");

  useInterval(() => {
    fetch("/api/feed")
      .then((r) => r.json())
      .then((d: { feed: FeedLine[] }) => setFeed(d.feed ?? []))
      .catch(() => {});
  }, 10_000, "feed");

  async function decide(id: number, action: "approve" | "later") {
    const res = await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    if (res.ok) {
      const d = (await res.json()) as { proposals: Proposal[]; ventures: Venture[] };
      setProposals(d.proposals ?? []);
      setVentures(d.ventures ?? []);
    }
  }

  const coreLabel =
    statusLine === COPY.idle || !bootDone
      ? COPY.systemsNominal
      : statusLine.toUpperCase();

  const speaking =
    hudState === "speaking" || hudState === "streaming" || hudState === "thinking";

  const activeVotes = tank.filter((t) => t.vote === "LONG" || t.vote === "SHORT" || t.vote === "HOLD");
  const longs = activeVotes.filter((t) => t.vote === "LONG").length;
  const avgConf = activeVotes.length
    ? Math.round(activeVotes.reduce((s, t) => s + t.conf, 0) / activeVotes.length)
    : 0;
  const consensus = activeVotes.length
    ? `${longs}/${activeVotes.length} LONG · ${avgConf}% AVG`
    : "POLLING MODELS…";

  const totalExposure =
    portfolio.positions?.reduce((s, p) => s + p.exposureDollars, 0) ?? 0;
  const exposurePct =
    portfolio.balanceDollars && portfolio.balanceDollars > 0
      ? ((totalExposure / (portfolio.balanceDollars + totalExposure)) * 100).toFixed(1)
      : null;

  return (
    <div id="stage-wrap">
      <div id="stage" ref={stageRef}>
        <div className="ambient-dots" />
        <div className="ambient-scanlines" />
        <div className="ambient-sweep" />

        <header className="topbar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="badge" src="/brand/badge.png" alt="STARRA badge" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="wordmark" src="/brand/wordmark.png" alt="STARRA" />
          <div className="topbar-id">
            <span className="topbar-label">
              STARGATE&nbsp;·&nbsp;STARRA&nbsp;LLC&nbsp;COMMAND
            </span>
            <span className="topbar-status">
              OPERATOR LINK ACTIVE
              <span style={{ marginLeft: 12, opacity: 0.7 }}>
                <Link href="/brief">BRIEF</Link>
                {" · "}
                <Link href="/tools">TOOLS</Link>
                {" · "}
                <Link href="/settings">LINK APIS</Link>
              </span>
            </span>
          </div>
          <div className="spacer" />
          <div className="vitals">
            <div className="vital">
              <span className="vital-label">CPU</span>
              <span className="vital-value">
                {vitals ? `${vitals.cpu}%` : "—"}
              </span>
            </div>
            <div className="vital">
              <span className="vital-label">MEM</span>
              <span className="vital-value">
                {vitals ? `${vitals.mem}%` : "—"}
              </span>
            </div>
            <div className="vital">
              <span className="vital-label">TOKENS</span>
              <span className="vital-value">
                {vitals ? vitals.tokens.toLocaleString() : "—"}
              </span>
            </div>
            <div className="vital">
              <span className="vital-label">UPTIME</span>
              <span className="vital-value">
                {vitals ? fmtUptime(vitals.uptime_seconds) : "—"}
              </span>
            </div>
            <div className="vital vital-clock">
              <span className="vital-label">LOCAL TIME</span>
              <span className="vital-value">{clock}</span>
            </div>
          </div>
          <button
            type="button"
            className={`eco-btn${eco ? " on" : ""}`}
            title="Low power — pauses decorative animations"
            onClick={() => setEco((v) => !v)}
          >
            {eco ? "ECO ON" : "ECO"}
          </button>
        </header>

        <div className="main-grid">
          {/* ── LEFT ── */}
          <div className="col col-left">
            <div className="panel" id="panel-dragon">
              <div className="panel-head">
                <span className="dot" />
                <span className="panel-title">DRAGON TRADAR</span>
                <div className="spacer" />
                {portfolio.linked ? (
                  <span className="panel-tag pulse" style={{ color: "#6ee7a0" }}>
                    ● LIVE UPLINK
                  </span>
                ) : (
                  <Link href="/settings#link-apis" className="panel-tag warn">
                    ▲ LINK KALSHI API
                  </Link>
                )}
              </div>
              <div className="dragon-summary">
                <div className="stat-block">
                  <span className="stat-label">BALANCE</span>
                  <span className="stat-value big">
                    {portfolio.linked && portfolio.balanceDollars !== undefined
                      ? fmtMoney(portfolio.balanceDollars)
                      : "— LINK —"}
                  </span>
                </div>
                <div className="stat-block">
                  <span className="stat-label">POSITIONS</span>
                  <span className="stat-value">
                    {portfolio.linked ? (portfolio.positions?.length ?? 0) : "—"}
                  </span>
                </div>
                <div className="stat-block">
                  <span className="stat-label">EXPOSURE</span>
                  <span className="stat-value">
                    {exposurePct !== null ? `${exposurePct}%` : "—"}
                  </span>
                </div>
              </div>
              <div className="row-list">
                {portfolio.linked && portfolio.positions?.length
                  ? portfolio.positions.map((p) => (
                      <div className="row-item" key={p.ticker}>
                        <span
                          className="row-side"
                          style={{
                            background: p.side === "YES" ? "#6ee7a0" : "#ff6b8a",
                          }}
                        >
                          {p.side}
                        </span>
                        <span className="row-market">{p.ticker}</span>
                        <span className="row-price">×{p.quantity}</span>
                        <span className="row-pnl">
                          {fmtMoney(p.exposureDollars)}
                        </span>
                      </div>
                    ))
                  : watchlist.map((m) => (
                      <div className="row-item" key={m.ticker} title={m.title}>
                        <span
                          className="row-side"
                          style={{
                            background: m.lastCents >= 50 ? "#6ee7a0" : "#ff6b8a",
                          }}
                        >
                          {m.lastCents >= 50 ? "YES" : "NO"}
                        </span>
                        <span className="row-market">
                          {(m.subtitle || m.title).toUpperCase()}
                        </span>
                        <span className="row-price">{m.lastCents}¢</span>
                        <span className="row-pnl" style={{ color: "var(--text-dim)" }}>
                          {m.volume >= 1000
                            ? `${Math.round(m.volume / 1000)}K vol`
                            : `${m.volume} vol`}
                        </span>
                      </div>
                    ))}
                {!watchlist.length && !portfolio.positions?.length ? (
                  <div className="feed-empty">Reaching Kalshi uplink…</div>
                ) : null}
              </div>
            </div>

            <div className="panel" id="panel-tank">
              <div className="panel-head">
                <span className="dot" />
                <span className="panel-title">THINK TANK</span>
                <div className="spacer" />
                <span className="panel-tag">{consensus}</span>
              </div>
              <div className="tank-grid">
                {(tank.length
                  ? tank
                  : [{ name: "LOCAL", vote: "…", conf: 0 }]
                ).map((t) => (
                  <div
                    className="tank-card"
                    key={t.name}
                    title={t.vote === "LINK" ? "Add key in Settings → LINK APIS" : tankTopic}
                  >
                    <span className="tank-name">{t.name}</span>
                    <span className="tank-vote" style={{ color: voteColor(t.vote) }}>
                      {t.vote}
                    </span>
                    <span className="tank-conf">
                      {t.vote === "LINK" ? "no key" : t.conf ? `${t.conf}%` : "…"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel panel-grow" id="panel-site">
              <div className="panel-head">
                <span className="dot" />
                <span className="panel-title">SITE TELEMETRY</span>
                <div className="spacer" />
                <span
                  className="panel-tag"
                  style={{ color: telemetry?.up ? "#6ee7a0" : "#ff6b8a" }}
                >
                  {telemetry ? (telemetry.up ? "● ONLINE" : "○ DOWN") : "…"}{" "}
                  dragontradar.com
                </span>
              </div>
              <div className="site-grid">
                <div className="site-card">
                  <span className="site-label">LATENCY</span>
                  <div className="site-value-row">
                    <span className="site-value">
                      {telemetry ? `${telemetry.latencyMs}ms` : "—"}
                    </span>
                  </div>
                </div>
                <div className="site-card">
                  <span className="site-label">UPTIME (SESSION)</span>
                  <div className="site-value-row">
                    <span className="site-value">
                      {telemetry ? `${telemetry.uptimePct}%` : "—"}
                    </span>
                    <span className="site-delta">
                      {telemetry ? `${telemetry.samples} probes` : ""}
                    </span>
                  </div>
                </div>
                <div className="site-card">
                  <span className="site-label">ACTIVE BOTS</span>
                  <div className="site-value-row">
                    <span className="site-value">
                      {telemetry?.stats && "bots" in telemetry.stats
                        ? String(telemetry.stats.bots)
                        : "LINK"}
                    </span>
                  </div>
                </div>
                <div className="site-card">
                  <span className="site-label">TRADES 24H</span>
                  <div className="site-value-row">
                    <span className="site-value">
                      {telemetry?.stats && "trades24h" in telemetry.stats
                        ? String(telemetry.stats.trades24h)
                        : "LINK"}
                    </span>
                  </div>
                </div>
              </div>
              {!telemetry?.statsLinked ? (
                <Link
                  href="/settings#link-apis"
                  className="panel-tag warn"
                  style={{ marginTop: "auto" }}
                >
                  ▲ LINK STATS API for bots/users/trades
                </Link>
              ) : null}
            </div>
          </div>

          {/* ── CENTER ── */}
          <div className="col col-center">
            <ReactorEye speaking={speaking} label={coreLabel} onMic={onMic} />
            <DeckConsole onMic={onMic} />
          </div>

          {/* ── RIGHT ── */}
          <div className="col col-right">
            <div className="panel panel-grow-11" id="panel-feed">
              <div className="panel-head">
                <span className="dot" />
                <span className="panel-title">AGENT OPS</span>
                <div className="spacer" />
                <span className="panel-tag faint">live server feed</span>
              </div>
              <div className="feed-list">
                {feed.length === 0 ? (
                  <div className="feed-empty">
                    Awaiting agent activity — tool calls will appear here.
                  </div>
                ) : (
                  feed.map((f) => (
                    <div className="feed-line" key={f.id}>
                      <span className="feed-time">{f.time}</span>
                      <span className="feed-tag" style={{ color: f.color }}>
                        {f.tag}
                      </span>
                      <span className="feed-text">{f.text}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="panel panel-grow" id="panel-proposals">
              <div className="panel-head">
                <span className="dot dot-warn" />
                <span className="panel-title">PROPOSALS</span>
                <div className="spacer" />
                <span className="panel-tag warn">
                  {proposals.length} AWAITING
                </span>
              </div>
              <div className="proposals-list">
                {proposals.length === 0 ? (
                  <div className="feed-empty">Queue clear. STARRA will file new proposals here.</div>
                ) : (
                  proposals.map((pr) => (
                    <div className="proposal-card" key={pr.id}>
                      <div className="proposal-top">
                        <span className="proposal-tag">{pr.tag}</span>
                        <span className="proposal-text">{pr.text}</span>
                      </div>
                      <div className="proposal-bottom">
                        <span className="proposal-impact">{pr.impact}</span>
                        <div className="spacer" />
                        <button
                          type="button"
                          className="btn-approve"
                          onClick={() => void decide(pr.id, "approve")}
                        >
                          APPROVE
                        </button>
                        <button
                          type="button"
                          className="btn-later"
                          onClick={() => void decide(pr.id, "later")}
                        >
                          LATER
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="panel" id="panel-ventures">
              <div className="panel-head">
                <span className="dot" />
                <span className="panel-title">STARRA LLC VENTURES</span>
              </div>
              <div className="row-list">
                {ventures.map((vn) => (
                  <div className="venture-row" key={vn.name}>
                    <span
                      className="venture-dot"
                      style={{
                        background: vn.color,
                        boxShadow: `0 0 6px ${vn.color}`,
                      }}
                    />
                    <span className="venture-name">{vn.name}</span>
                    <span className="venture-status" style={{ color: vn.color }}>
                      {vn.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {!bootDone ? <DeckBoot onDone={onBootDone} /> : null}
      </div>
    </div>
  );
}
