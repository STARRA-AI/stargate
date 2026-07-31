"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { COPY } from "@/lib/copy";
import { fmtMoney } from "@/lib/deck-demo";
import { MOTION } from "@/lib/motion/assets";
import { useCineVideo } from "@/lib/motion/useCineVideo";
import { useStargate } from "@/lib/stargate-context";
import { requestBriefingCall } from "@/lib/voice/useVoiceCall";
import { useVoiceLoop } from "@/lib/voice/useVoiceLoop";
import { DeckBoot } from "./DeckBoot";
import { DeckConsole } from "./DeckConsole";
import { FlipRadar } from "./FlipRadar";
import { FundingPanel } from "./FundingPanel";
import { ShadowPanel } from "./ShadowPanel";
import { SnapHydrator } from "./SnapHydrator";
import { useStageScale } from "./useStageScale";
import { VoiceCallOverlay } from "./VoiceCallOverlay";
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
type MobileTab = "today" | "ops" | "memory" | "links";

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

function useInterval(fn: () => void, ms: number) {
  // Ref-latch: keep the latest callback available to the tick without
  // forcing the interval to be torn down/recreated on every render (which
  // would also reset the ms-based cadence). Updated after every render so
  // the tick always reads current state (fixes stale `bootDone` closure).
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    // Skip the poll while the tab is backgrounded — a hidden tab has no
    // reason to keep hitting /api/* on a timer — and catch back up with a
    // single fetch the moment it regains visibility instead of waiting out
    // whatever's left of the current interval.
    const tick = () => {
      if (document.hidden) return;
      fnRef.current();
    };
    tick();
    const id = setInterval(tick, ms);
    const onVisibility = () => {
      if (!document.hidden) fnRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms]);
}

export function Bridge() {
  const {
    statusLine,
    setBootDone,
    bootDone,
    hudState,
    lastReply,
    snap,
    connectors,
  } = useStargate();
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
  const [eco, setEco] = useState(false); /* launches with full motion; toggle ECO on if the machine needs it */
  const [shine, setShine] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("today");
  const [callOpen, setCallOpen] = useState(false);
  const badgeCineRef = useRef<HTMLVideoElement>(null);
  const shineRef = useRef<HTMLVideoElement>(null);

  useVoiceLoop({ suspended: callOpen });

  const onBootDone = useCallback(() => {
    setBootDone(true);
    setShine(true);
  }, [setBootDone]);

  // ONE call entry, everywhere: the composer call button, tapping her reactor
  // core, and tapping the mobile hero badge all open the full-screen call —
  // her face + the live xAI voice. END CALL in the overlay hangs up. No
  // separate native window, no redundant mic button.
  const openCall = useCallback(() => setCallOpen(true), []);
  const closeCall = useCallback(() => setCallOpen(false), []);

  // MORNING BRIEFING: BRIEF opens the call with the composed sixty-second
  // brief riding her instructions. A once-per-day banner nudges after 7am
  // (localStorage stamp); pressing BRIEF anywhere stamps the day done.
  const [briefBanner, setBriefBanner] = useState(false);
  const briefStamp = () => `starra_brief_${new Date().toISOString().slice(0, 10)}`;
  const openBriefing = useCallback(() => {
    try {
      localStorage.setItem(briefStamp(), "1");
    } catch {
      /* stamping is a nicety */
    }
    setBriefBanner(false);
    requestBriefingCall();
    setCallOpen(true);
  }, []);
  useEffect(() => {
    if (!bootDone) return;
    try {
      setBriefBanner(
        new Date().getHours() >= 7 && localStorage.getItem(briefStamp()) === null,
      );
    } catch {
      /* no storage — no banner */
    }
  }, [bootDone]);

  const motionOk = !eco && !reduced && bootDone;

  useCineVideo(badgeCineRef, {
    src: MOTION.badgeHeartbeat,
    active: motionOk,
    loop: true,
    allowPlay: motionOk,
  });

  useCineVideo(shineRef, {
    src: MOTION.wordmarkShine,
    active: shine && motionOk,
    loop: false,
    allowPlay: motionOk,
  });

  useEffect(() => {
    document.documentElement.classList.add("deck-active");
    return () => document.documentElement.classList.remove("deck-active");
  }, []);

  useEffect(() => {
    document.body.classList.toggle("low-power", eco);
  }, [eco]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (isMobile && !bootDone) {
      setBootDone(true);
    }
  }, [bootDone, isMobile, setBootDone]);

  useEffect(() => {
    const el = shineRef.current;
    if (!el || !shine) return;
    const onEnded = () => setShine(false);
    el.addEventListener("ended", onEnded);
    return () => el.removeEventListener("ended", onEnded);
  }, [shine]);

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString("en-US", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* ── live polling (wait for boot; ECO doubles intervals) ── */
  const pollMul = eco ? 2 : 1;

  useInterval(() => {
    if (!bootDone) return;
    fetch("/api/vitals")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(setVitals)
      .catch(() => {});
  }, 12_000 * pollMul);

  useInterval(() => {
    if (!bootDone) return;
    fetch("/api/dragon")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: { watchlist: WatchMarket[]; portfolio: Portfolio }) => {
        setWatchlist(d.watchlist ?? []);
        setPortfolio(d.portfolio ?? { linked: false });
      })
      .catch(() => {});
  }, 90_000 * pollMul);

  useInterval(() => {
    if (!bootDone) return;
    fetch("/api/tank")
      .then((r) => r.json())
      .then((d: { votes: TankVote[]; topic: string }) => {
        setTank(d.votes ?? []);
        setTankTopic(d.topic ?? "");
      })
      .catch(() => {});
  }, 90_000 * pollMul);

  useInterval(() => {
    if (!bootDone) return;
    fetch("/api/telemetry")
      .then((r) => r.json())
      .then(setTelemetry)
      .catch(() => {});
  }, 90_000 * pollMul);

  useInterval(() => {
    if (!bootDone) return;
    fetch("/api/proposals")
      .then((r) => r.json())
      .then((d: { proposals: Proposal[]; ventures: Venture[] }) => {
        setProposals(d.proposals ?? []);
        setVentures(d.ventures ?? []);
      })
      .catch(() => {});
  }, 120_000 * pollMul);

  useInterval(() => {
    if (!bootDone) return;
    fetch("/api/feed")
      .then((r) => r.json())
      .then((d: { feed: FeedLine[] }) => setFeed(d.feed ?? []))
      .catch(() => {});
  }, 20_000 * pollMul);

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

  const mobileReply = lastReply || "Standing by, operator.";

  if (isMobile) {
    return (
      <div className="mobile-bridge">
        <SnapHydrator />
        <div className={`mobile-shell mobile-hud-${hudState}`}>
          <div className="mobile-ambient mobile-ambient-a" />
          <div className="mobile-ambient mobile-ambient-b" />

          <header className="mobile-topbar">
            <div className="mobile-topbar-left">
              <div className="badge-wrap mobile-badge-wrap">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="mobile-topbar-badge" src="/brand/badge.webp" alt="" aria-hidden />
              </div>
              <div className="mobile-topbar-copy">
                <span className="mobile-topbar-kicker">STARGATE</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="mobile-wordmark" src="/brand/wordmark.webp" alt="STARRA" />
              </div>
            </div>
            <div className="mobile-topbar-status">
              <span className="mobile-topbar-dot" />
              <span>{statusLine === COPY.systemsNominal ? "NOMINAL" : statusLine.toUpperCase()}</span>
            </div>
          </header>

          <section className="mobile-hero">
            <div className="mobile-hero-ring">
              <div className="mobile-hero-glow" />
              <div className="mobile-reactor">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="mobile-ring mobile-ring-outer"
                  src="/brand/hud_ring.webp"
                  alt=""
                  aria-hidden
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="mobile-ring mobile-ring-inner"
                  src="/brand/hud_ring.webp"
                  alt=""
                  aria-hidden
                />
                <button
                  type="button"
                  className="mobile-hero-badge"
                  onClick={openCall}
                  aria-label="Call STARRA"
                  aria-pressed={
                    hudState === "wake" ||
                    hudState === "listening" ||
                    hudState === "thinking" ||
                    hudState === "streaming" ||
                    hudState === "speaking"
                  }
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/brand/badge.webp" alt="Activate voice" />
                </button>
              </div>
            </div>
            <p className="mobile-hero-label">{COPY.tapToSpeak}</p>
            <p className="mobile-hero-status">{statusLine}</p>
          </section>

          <section className="mobile-last-reply">
            <span className="mobile-last-reply-mark">◆</span>
            <p>{mobileReply}</p>
          </section>

          <nav className="mobile-tabs" aria-label="Bridge panels">
            {[
              ["today", "TODAY"],
              ["ops", "OPS"],
              ["memory", "MEM"],
              ["links", "LINKS"],
            ].map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                className={`mobile-tab${mobileTab === tab ? " active" : ""}`}
                onClick={() => setMobileTab(tab as MobileTab)}
                aria-pressed={mobileTab === tab}
              >
                {label}
              </button>
            ))}
          </nav>

          <section className="mobile-panel" key={mobileTab}>
            {mobileTab === "today" ? (
              <div className="mobile-stack">
                <div className="mobile-block">
                  <div className="mobile-block-head">
                    <span>BUSINESS SNAP</span>
                    <Link href="/settings">EDIT</Link>
                  </div>
                  <div className="mobile-stat-list">
                    <div className="mobile-stat-row">
                      <span>MRR</span>
                      <strong>{snap.mrrLabel}</strong>
                    </div>
                    <div className="mobile-stat-row">
                      <span>TASKS DUE</span>
                      <strong>{String(snap.tasksDue).padStart(2, "0")}</strong>
                    </div>
                    <div className="mobile-stat-row">
                      <span>PIPELINE OPEN</span>
                      <strong>{String(snap.pipelineOpen).padStart(2, "0")}</strong>
                    </div>
                  </div>
                </div>
                <div className="mobile-block">
                  <div className="mobile-block-head">
                    <span>PROPOSALS</span>
                    <span>{proposals.length} AWAITING</span>
                  </div>
                  <div className="mobile-list">
                    {proposals.length === 0 ? (
                      <p className="mobile-empty">QUEUE CLEAR.</p>
                    ) : (
                      proposals.slice(0, 3).map((pr) => (
                        <div className="mobile-list-card" key={pr.id}>
                          <span className="mobile-list-tag">{pr.tag}</span>
                          <p>{pr.text}</p>
                          <small>{pr.impact}</small>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {mobileTab === "ops" ? (
              <div className="mobile-stack">
                <div className="mobile-block">
                  <div className="mobile-block-head">
                    <span>AGENT OPS</span>
                    <span>LIVE</span>
                  </div>
                  <div className="mobile-feed">
                    {feed.length === 0 ? (
                      <p className="mobile-empty">AWAITING AGENT ACTIVITY.</p>
                    ) : (
                      feed.slice(0, 7).map((item) => (
                        <div className="mobile-feed-line" key={item.id}>
                          <span>{item.time}</span>
                          <strong style={{ color: item.color }}>{item.tag}</strong>
                          <p>{item.text}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {mobileTab === "memory" ? (
              <div className="mobile-stack">
                <div className="mobile-block">
                  <div className="mobile-block-head">
                    <span>MEMORY</span>
                    <Link href="/memory">OPEN</Link>
                  </div>
                  <div className="mobile-stat-list">
                    <div className="mobile-stat-row">
                      <span>WORKING</span>
                      <strong>{snap.working} MSGS</strong>
                    </div>
                    <div className="mobile-stat-row">
                      <span>SUMMARY</span>
                      <strong>{snap.summaries} SUMS</strong>
                    </div>
                    <div className="mobile-stat-row">
                      <span>ARCHIVAL</span>
                      <strong>{snap.archival} ARC</strong>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {mobileTab === "links" ? (
              <div className="mobile-stack">
                <div className="mobile-block">
                  <div className="mobile-block-head">
                    <span>CONNECTORS</span>
                    <Link href="/connectors">MANAGE</Link>
                  </div>
                  <div className="mobile-connectors">
                    {connectors.map((connector) => (
                      <div className="mobile-connector-row" key={connector.id}>
                        <span>{connector.name}</span>
                        <strong>{connector.status}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <div className="mobile-console">
            <DeckConsole onCall={openCall} callActive={callOpen} />
          </div>
        </div>
        <VoiceCallOverlay open={callOpen} onClose={closeCall} />
      </div>
    );
  }

  return (
    <div id="stage-wrap">
      <SnapHydrator />
      <div id="stage" ref={stageRef} data-hud={hudState}>
        {/* LIVING GALAXY (2026-07-30) — the machine is alive. One slow rotate
            verb on the nebula, breathe on the star layers, three shooting
            stars on long offsets. Transform+opacity only; ECO and
            prefers-reduced-motion hold all of it still (deck.css). */}
        <div className="galaxy-spin" aria-hidden />
        <div className="galaxy-stars galaxy-stars-a" aria-hidden />
        <div className="galaxy-stars galaxy-stars-b" aria-hidden />
        <div className="shooting-star ss-1" aria-hidden />
        <div className="shooting-star ss-2" aria-hidden />
        <div className="shooting-star ss-3" aria-hidden />
        <div className="ambient-dots" />
        <div className="ambient-scanlines" />
        <div className="ambient-sweep" />

        <header className="topbar">
          <div className="badge-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="badge" src="/brand/badge.webp" alt="STARRA badge" />
            <video
              ref={badgeCineRef}
              className="badge-cine"
              muted
              playsInline
              loop
              preload="metadata"
              style={{ opacity: motionOk ? 0.55 : 0 }}
              aria-hidden
            />
          </div>
          <div className="wordmark-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="wordmark" src="/brand/wordmark.webp" alt="STARRA" />
            <video
              ref={shineRef}
              className="wordmark-cine"
              muted
              playsInline
              preload="metadata"
              style={{ opacity: shine && motionOk ? 0.85 : 0 }}
              aria-hidden
            />
          </div>
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
          {/* Full deck reload. Load-bearing in the dock app: the WKWebView has
              no browser chrome, so without this a wedged deck means quitting
              the whole app. Reload also re-seeds history from the shared
              memory store (stargate-context boot seeding). */}
          <button
            type="button"
            className="eco-btn"
            title="Reload the deck — fresh page, memory re-synced"
            onClick={() => window.location.reload()}
          >
            REFRESH
          </button>
          <button
            type="button"
            className="eco-btn"
            title="Morning briefing call — sixty seconds across every panel"
            onClick={openBriefing}
          >
            BRIEF
          </button>
        </header>

        {briefBanner ? (
          <button type="button" className="brief-banner" onClick={openBriefing}>
            MORNING BRIEFING READY — TAP TO HEAR IT
          </button>
        ) : null}

        <div className="main-grid">
          {/* ── LEFT ── */}
          <div className="col col-left">
            <FlipRadar />
            <div className="panel" id="panel-snap">
              <div className="panel-head">
                <span className="dot" />
                <span className="panel-title">BUSINESS SNAP</span>
                <div className="spacer" />
                <Link href="/settings" className="panel-tag">
                  EDIT
                </Link>
              </div>
              <div className="snap-metrics">
                <div className="snap-metric">
                  <span className="snap-label">MRR</span>
                  <span className="snap-value">{snap.mrrLabel}</span>
                </div>
                <div className="snap-metric">
                  <span className="snap-label">TASKS DUE</span>
                  <span className="snap-value">
                    {String(snap.tasksDue).padStart(2, "0")}
                  </span>
                </div>
                <div className="snap-metric">
                  <span className="snap-label">PIPELINE OPEN</span>
                  <span className="snap-value">
                    {String(snap.pipelineOpen).padStart(2, "0")}
                  </span>
                </div>
              </div>
              <div className="memory-strip">
                <div className="memory-cell">
                  <span className="memory-label">WORKING</span>
                  <span className="memory-value">{snap.working}</span>
                </div>
                <div className="memory-cell">
                  <span className="memory-label">SUMMARY</span>
                  <span className="memory-value">{snap.summaries}</span>
                </div>
                <div className="memory-cell">
                  <span className="memory-label">ARCHIVAL</span>
                  <span className="memory-value">{snap.archival}</span>
                </div>
              </div>
            </div>

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
          {/* ReactorEye REMOVED entirely (Classic's order, 2026-07-30): its
              webcam-gaze tracking was pointless data collection. The console
              carries the call control; the camera is never opened. */}
          <div className="col col-center">
            <DeckConsole onCall={openCall} callActive={callOpen} /></div>

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
                    AWAITING AGENT ACTIVITY.
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
                  <div className="feed-empty">QUEUE CLEAR.</div>
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

            <ShadowPanel />
            <FundingPanel />
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
      <VoiceCallOverlay open={callOpen} onClose={closeCall} />
    </div>
  );
}
