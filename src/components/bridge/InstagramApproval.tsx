"use client";

/**
 * INSTAGRAM APPROVAL panel (G9) — the Kalshi "— LINK —" pattern
 * (Bridge.tsx:733-746) applied to Agent B's staged-post queue
 * (SHARED CONTRACT §9). When not linked: the literal string "— LINK —"
 * plus a `<Link href="/settings#link-apis">` cue — never a fake preview,
 * never an engagement number. When linked: each staged post gets an
 * explicit APPROVE & PUBLISH action behind a confirm step, and a separate
 * DISCARD. This component makes no network call to graph.facebook.com or
 * any Meta host — approval only ever POSTs to this repo's own
 * /api/social/instagram/approve, which per contract is the sole permitted
 * caller of the Graph API, server-side.
 *
 * StagedPost's exact field set isn't pinned down in the contract beyond
 * "staged: StagedPost[]" — the fields below (caption/mediaUrl/mediaType/
 * createdAt) are the reasonable minimum implied by "caption + media
 * preview" in the G9 brief. Rendering is defensive: every field is
 * optional and missing ones fall back to plain text, never a fabricated
 * value. Not yet verified against Agent B's real route (absent on disk at
 * build time) — flagged in the round report.
 *
 * DISCARD: the contract (§9) defines only GET, /stage, and /approve — no
 * un-stage/delete endpoint. DISCARD here only dismisses the card from this
 * view; it does not remove the post server-side. That gap is called out in
 * the round report for Agent B.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type StagedPost = {
  id: string;
  caption?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  createdAt?: string;
};

type InstagramFeed = { linked: boolean; reason?: string; staged: StagedPost[] };

export function InstagramApproval() {
  const [feed, setFeed] = useState<InstagramFeed | null>(null);
  const [error, setError] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    fetch("/api/social/instagram")
      .then((r) => r.json())
      .then((d: InstagramFeed) => {
        setFeed(d);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(post: StagedPost) {
    setBusyId(post.id);
    try {
      const res = await fetch("/api/social/instagram/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: post.id }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        published?: { id: string };
        error?: string;
      };
      if (d.ok) {
        setResult((r) => ({
          ...r,
          [post.id]: `PUBLISHED — ${d.published?.id ?? "ok"}`,
        }));
        load();
      } else {
        setResult((r) => ({ ...r, [post.id]: d.error ?? "PUBLISH FAILED" }));
      }
    } catch {
      setResult((r) => ({ ...r, [post.id]: "LINK DEGRADED. RETRY?" }));
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  }

  function discard(id: string) {
    setDismissed((d) => new Set(d).add(id));
    setConfirmingId(null);
  }

  const staged = (feed?.staged ?? []).filter((p) => !dismissed.has(p.id));

  return (
    <div className="panel" id="panel-instagram">
      <div className="panel-head">
        <span className="dot" />
        <span className="panel-title">INSTAGRAM</span>
        <div className="spacer" />
        {feed?.linked ? (
          <span className="panel-tag">{staged.length} STAGED</span>
        ) : (
          <Link href="/settings#link-apis" className="panel-tag warn">
            ▲ LINK INSTAGRAM
          </Link>
        )}
      </div>

      {error ? (
        <div className="feed-empty">LINK DEGRADED. RETRY?</div>
      ) : !feed ? (
        <div className="feed-empty">Reaching Instagram bridge…</div>
      ) : !feed.linked ? (
        <div className="row-list">
          <div className="feed-empty">
            — LINK —{" "}
            {feed.reason ?? "add the Instagram key in Settings → Link APIs."}
          </div>
          <Link href="/settings#link-apis" className="panel-tag warn">
            ▲ OPEN LINK APIS
          </Link>
        </div>
      ) : staged.length === 0 ? (
        <div className="feed-empty">QUEUE CLEAR.</div>
      ) : (
        <div className="row-list">
          {staged.map((post) => (
            <div className="proposal-card" key={post.id}>
              <div className="proposal-top">
                {post.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={post.mediaUrl}
                    alt=""
                    aria-hidden
                    style={{
                      width: 44,
                      height: 44,
                      objectFit: "cover",
                      borderRadius: 4,
                      flexShrink: 0,
                    }}
                  />
                ) : null}
                <span className="proposal-text">
                  {post.caption || "(no caption)"}
                </span>
              </div>
              <div className="proposal-bottom">
                <span className="proposal-impact">
                  {result[post.id] ??
                    (post.createdAt ? `staged ${post.createdAt}` : "staged")}
                </span>
                <div className="spacer" />
                {confirmingId === post.id ? (
                  <>
                    <span className="proposal-impact">PUBLISH NOW?</span>
                    <button
                      type="button"
                      className="btn-approve"
                      disabled={busyId === post.id}
                      onClick={() => void approve(post)}
                      aria-label={`Confirm publish: ${post.caption || post.id}`}
                    >
                      CONFIRM
                    </button>
                    <button
                      type="button"
                      className="btn-later"
                      onClick={() => setConfirmingId(null)}
                      aria-label="Cancel publish"
                    >
                      CANCEL
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn-approve"
                      onClick={() => setConfirmingId(post.id)}
                      aria-label={`Approve and publish: ${post.caption || post.id}`}
                    >
                      APPROVE &amp; PUBLISH
                    </button>
                    <button
                      type="button"
                      className="btn-later"
                      onClick={() => discard(post.id)}
                      aria-label={`Discard staged post: ${post.caption || post.id}`}
                    >
                      DISCARD
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
