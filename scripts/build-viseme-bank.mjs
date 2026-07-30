#!/usr/bin/env node
/**
 * build-viseme-bank.mjs — OFFLINE, one-time, ffmpeg-only, $0, no network, no GPU.
 *
 *   RUN IT WITH:   node scripts/build-viseme-bank.mjs
 *   (from the repo root: /Users/work/Desktop/STARGATE/stargate)
 *
 * ── SUPERSEDED FOR THE LIVE PATH — READ THIS FIRST ──────────────────────────
 * This script builds the 1-D bank (bank.json + v00..v07.png) and the anchor
 * track (anchor.json). It STILL RUNS and still produces both, and the runtime
 * keeps bank.json as its FALLBACK. But it is no longer what drives her mouth:
 * the live path now prefers the 2-D bank built by
 *
 *     python3 scripts/build-viseme-bank-2d.py
 *
 * WHY, measured on her own footage. Rendering these eight PNGs as a labelled
 * ladder shows SIX of them are visibly CLOSED mouths — including v04
 * (openness 0.563, source frame 103) and v05 (openness 0.688, source frame 225).
 * The openness scale below is therefore NOT monotonic in aperture: only its
 * extremes are correct, so at openness 0.5 the renderer drew a shut mouth and
 * her mouth only opened above ~0.75.
 *
 * The root cause is in the clip, not in the code, and it bounds any bank built
 * from it: her openness distribution is BIMODAL. Of 354 frames, 295 sit below
 * openness 0.2 and 54 above 0.7, with only 5 frames in the entire 0.2-0.7
 * middle. Section 3 below asks for BANK_COUNT EVENLY SPACED openness bands, so
 * on two-state footage its middle bands can only be filled with closed frames
 * carrying invented mid-range labels. That is exactly what happened.
 *
 * The 2-D builder does not force a uniform ladder. It records each chosen
 * frame's TRUE measured openness AND a second measured axis (roundness, from
 * corner-to-corner lip width), and flags any requested cell with no real frame
 * near it as an approximation instead of mislabelling one.
 *
 * ANCHOR.JSON IS STILL OWNED HERE. The 2-D builder READS anchor.json and never
 * writes it, so this remains the only producer of the mouth-box track. Re-run
 * this first if the track ever needs rebuilding, then re-run the 2-D builder.
 *
 * There is deliberately NO npm script for this: package.json is owned by another
 * agent, so this file documents its own invocation instead. Optional flags:
 *   --clip <path>   source clip           (default public/avatar/clips/talking.mp4)
 *   --out  <dir>    output dir            (default public/avatar/visemes)
 *   --count <n>     bank size             (default 8)
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * Cuts a small bank of MOUTH-ONLY crops out of her REAL talking footage, at
 * NATIVE resolution, plus a per-frame mouth-box track so the runtime patch
 * FOLLOWS her head instead of drifting. The runtime (viseme-sync.ts +
 * StarraClipFace.tsx) then paints the bank frame whose openness matches her
 * LIVE audio over the still-playing base video — so her BODY keeps moving, the
 * skin/lighting/grain match exactly (same source footage), and it costs $0.
 *
 * ── WHY THE PIECES ARE WHAT THEY ARE (all measured, not assumed) ────────────
 * 1. ANCHOR = a nose template tracked by normalised cross-correlation.
 *    The NOSE is used, not the mouth, because the nose is RIGID: it moves with
 *    the head but does not deform when she speaks, so the match stays honest
 *    while the mouth is changing shape. The mouth box is a fixed offset from it.
 *    The search is SEQUENTIAL (warm-started from the previous frame). Measured
 *    on talking.mp4: a global search per frame teleports (max frame-to-frame
 *    jump 101.5px, and it locked onto her CHEEK for frames 254-286); the
 *    sequential search brings that to max 8.06px with NCC median 0.9796.
 * 2. CONFIDENCE = that same NCC, and its LIMITS are known. It reliably catches
 *    TRACKING FAILURE and gross pose loss (frames 245-286 fall to 0.75-0.79),
 *    and the runtime refuses to patch below the floor. It does NOT by itself
 *    catch a moderate three-quarter head turn: frame 328 is visibly turned yet
 *    still scores 0.979. Compositing proved a wider "perioral ring" NCC is no
 *    fix either — a ring threshold strict enough to reject frame 328 also
 *    rejects frame 179, which patches perfectly. What ACTUALLY makes moderate
 *    turns safe is geometry, not gating: centring the patch on the mouth and
 *    keeping it SMALL (see PATCH below). Confidence is the backstop for gross
 *    failure, not the primary defence.
 * 3. OPENNESS = a 1-D LINEAR DISCRIMINANT in pixel space,
 *       w = normalize(mean(open exemplars) - mean(closed exemplars))
 *       openness(f) = <normalize(lipROI(f)), w>
 *    with every ROI zero-meaned and unit-normed first so lighting offset/gain
 *    cancel. Hand-designed photometric metrics were TRIED AND REJECTED against
 *    eyeballed contact sheets: mean-luma, luma std-dev, dark-pixel fraction,
 *    longest-dark-run "aperture", and bright+desaturated "teeth" fraction all
 *    failed to order closed-vs-open correctly on this clip (her lip gloss is
 *    bright and specular, and jaw/neck shadow moves with the head, which is
 *    what those metrics ended up measuring). The discriminant orders it
 *    correctly. Exemplars are bootstrapped from the data, then refined once.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 * Writes ONLY inside the output dir. Never deletes. Refuses to run if the clip
 * is missing. Idempotent — re-running regenerates the same bank in place.
 * Reads public/avatar/clips/talking.mp4 READ-ONLY.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

// ── CLI ────────────────────────────────────────────────────────────────────
function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const ROOT = process.cwd();
const CLIP = path.resolve(ROOT, arg("--clip", "public/avatar/clips/talking.mp4"));
const OUT_DIR = path.resolve(ROOT, arg("--out", "public/avatar/visemes"));
const BANK_COUNT = Math.max(4, Math.min(16, Number(arg("--count", "8")) || 8));

// Never let --out escape the repo, and never let it point at her source clips.
const rel = path.relative(ROOT, OUT_DIR);
if (rel.startsWith("..") || path.isAbsolute(rel)) {
  console.error(`refusing: --out must stay inside the repo (got ${OUT_DIR})`);
  process.exit(1);
}
if (/public[/\\]avatar[/\\]clips/.test(OUT_DIR)) {
  console.error("refusing: --out must never point into public/avatar/clips (source footage is read-only)");
  process.exit(1);
}
if (!existsSync(CLIP)) {
  console.error(`refusing: source clip not found: ${CLIP}`);
  process.exit(1);
}

// ── GEOMETRY (native pixels, verified by eye against extracted frames) ──────
// Search region: the generous box the head stays inside for the whole clip.
const RX = 220, RY = 260, RW = 480, RH = 440;
// Nose template, taken from the reference frame. Rigid, high-contrast (nostrils).
const NOSE = { x: 385, y: 340, w: 100, h: 70 };
const REF_FRAME = 0;
// Her mouth CENTRE, as an offset from the tracked nose-template ORIGIN.
// Verified by eye: on frame 0 the nose origin is (385,340) and the mouth centres
// on ~(422,440). Everything below is centred on this, NOT hung off a corner.
const MOUTH_CENTRE = { dx: 37, dy: 100 };
// Mouth PATCH size. 140x100 was chosen by compositing the WORST case — the
// closed viseme (source frame 154) pasted onto frame 328, where her head is
// three-quarter turned. At 170x130 that patch dragged her jaw shadow and some
// background across her lit cheek as a visible smear; at 120x84 a wide-open
// mouth got clipped at the patch edge. 140x100 shows neither.
const PATCH = { w: 140, h: 100 };
// Lip SCORING roi, concentric with the patch. Tighter: just the lips.
const LIP = { w: 130, h: 92 };
const originOf = (cx, cy, w, h) => ({ dx: cx - Math.round(w / 2), dy: cy - Math.round(h / 2) });
const PATCH_O = originOf(MOUTH_CENTRE.dx, MOUTH_CENTRE.dy, PATCH.w, PATCH.h);
const LIP_O = originOf(MOUTH_CENTRE.dx, MOUTH_CENTRE.dy, LIP.w, LIP.h);
const LOCAL_R = 14;   // sequential search radius, px (measured p95 jump = 5.1px)
const SUB = 2;        // template subsample stride

// ── probe ──────────────────────────────────────────────────────────────────
function probe() {
  const out = execFileSync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
    "-of", "default=noprint_wrappers=1:nokey=0", CLIP,
  ]).toString();
  const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1];
  const [num, den] = (get("r_frame_rate") || "30/1").split("/").map(Number);
  return {
    width: Number(get("width")),
    height: Number(get("height")),
    fps: den ? num / den : num,
    nbFrames: Number(get("nb_frames")) || 0,
  };
}
const meta = probe();
if (!meta.width || !meta.height) {
  console.error("refusing: could not probe clip dimensions");
  process.exit(1);
}
console.log(`source ${path.relative(ROOT, CLIP)}  ${meta.width}x${meta.height} @ ${meta.fps}fps  nb_frames=${meta.nbFrames}`);
if (RX + RW > meta.width || RY + RH > meta.height) {
  console.error(`refusing: search region ${RW}x${RH}+${RX}+${RY} does not fit in ${meta.width}x${meta.height}`);
  process.exit(1);
}

// ── decode the search region once, as 8-bit gray ───────────────────────────
const raw = execFileSync(FFMPEG, [
  "-v", "error", "-i", CLIP,
  "-vf", `crop=${RW}:${RH}:${RX}:${RY},format=gray`,
  "-f", "rawvideo", "-pix_fmt", "gray", "-",
], { maxBuffer: 1 << 30 });
const FRAME = RW * RH;
const N = Math.floor(raw.length / FRAME);
if (N < 2) {
  console.error("refusing: decoded fewer than 2 frames");
  process.exit(1);
}
console.log(`decoded ${N} frames of the ${RW}x${RH} search region`);

// ── 1. anchor track: sequential NCC on the nose template ───────────────────
const grid = [];
for (let y = 0; y < NOSE.h; y += SUB) for (let x = 0; x < NOSE.w; x += SUB) grid.push([x, y]);
const G = grid.length;

const tOx = NOSE.x - RX, tOy = NOSE.y - RY;
const T = new Float64Array(G);
{
  let s = 0;
  for (let i = 0; i < G; i++) {
    T[i] = raw[REF_FRAME * FRAME + (tOy + grid[i][1]) * RW + tOx + grid[i][0]];
    s += T[i];
  }
  const m = s / G;
  for (let i = 0; i < G; i++) T[i] -= m;
}
let TN = 0;
for (let i = 0; i < G; i++) TN += T[i] * T[i];
TN = Math.sqrt(TN) || 1;

function nccAt(f, ox, oy) {
  if (ox < 0 || oy < 0 || ox + NOSE.w > RW || oy + NOSE.h > RH) return -2;
  const fb = f * FRAME;
  let sum = 0, ss = 0, cross = 0;
  for (let i = 0; i < G; i++) {
    const v = raw[fb + (oy + grid[i][1]) * RW + ox + grid[i][0]];
    sum += v; ss += v * v; cross += v * T[i];
  }
  const mean = sum / G;
  const varr = ss - G * mean * mean;
  if (varr <= 1e-9) return -2;
  return cross / (Math.sqrt(varr) * TN);
}

const anchors = [];
let px = tOx, py = tOy;
for (let f = 0; f < N; f++) {
  let best = -2, bx = px, by = py;
  for (let dy = -LOCAL_R; dy <= LOCAL_R; dy++) {
    for (let dx = -LOCAL_R; dx <= LOCAL_R; dx++) {
      const s = nccAt(f, px + dx, py + dy);
      if (s > best) { best = s; bx = px + dx; by = py + dy; }
    }
  }
  px = bx; py = by;
  anchors.push({ f, nx: bx + RX, ny: by + RY, ncc: best });
}

// light temporal smoothing of the box position (the NCC grid is integer-valued,
// so a 5-tap mean removes 1px shimmer without lagging real motion)
const smooth = (key) => {
  const src = anchors.map((a) => a[key]);
  return src.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < src.length) { s += src[j]; n++; } }
    return s / n;
  });
};
const sx = smooth("nx"), sy = smooth("ny");

const nccs = anchors.map((a) => a.ncc).sort((a, b) => a - b);
const xr = anchors.map((a) => a.nx), yr = anchors.map((a) => a.ny);
let maxJump = 0;
for (let i = 1; i < N; i++) maxJump = Math.max(maxJump, Math.hypot(anchors[i].nx - anchors[i - 1].nx, anchors[i].ny - anchors[i - 1].ny));
console.log(`anchor: X range ${Math.max(...xr) - Math.min(...xr)}px, Y range ${Math.max(...yr) - Math.min(...yr)}px, max frame-to-frame jump ${maxJump.toFixed(2)}px`);
console.log(`anchor NCC: min=${nccs[0].toFixed(4)} p05=${nccs[(N * 0.05) | 0].toFixed(4)} median=${nccs[(N / 2) | 0].toFixed(4)}`);

// ── 2. openness: linear discriminant over the anchored lip ROI ─────────────
const LIP_N = LIP.w * LIP.h;
function lipVec(f) {
  const a = anchors[f];
  const ox = a.nx + LIP_O.dx - RX, oy = a.ny + LIP_O.dy - RY, fb = f * FRAME;
  const v = new Float64Array(LIP_N);
  for (let y = 0; y < LIP.h; y++) {
    for (let x = 0; x < LIP.w; x++) {
      const xx = ox + x, yy = oy + y;
      v[y * LIP.w + x] = (xx >= 0 && xx < RW && yy >= 0 && yy < RH) ? raw[fb + yy * RW + xx] : 0;
    }
  }
  let s = 0;
  for (let i = 0; i < LIP_N; i++) s += v[i];
  const m = s / LIP_N;
  let n = 0;
  for (let i = 0; i < LIP_N; i++) { v[i] -= m; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < LIP_N; i++) v[i] /= n;
  return v;
}
const vecs = [];
for (let f = 0; f < N; f++) vecs.push(lipVec(f));

// Bootstrap exemplars: an open mouth adds a large dark CAVITY at the CENTRE of
// the lip ROI. The centre restriction is load-bearing and was found the hard
// way — counting dark pixels over the WHOLE lip ROI ranks frames by her jaw and
// neck SHADOW (which sits at the ROI border and swings with head pose), and it
// produced a bank of 8 near-identical closed mouths. Restricted to the central
// box the ranking is correct and stable: on talking.mp4 the top of this ranking
// is frames 304-321 (verified wide open by eye) and the bottom is frames
// 181-192 (verified closed), for every threshold percentile in 0.15..0.30.
const CIX = Math.round(LIP.w * 0.30), CIY = Math.round(LIP.h * 0.22);
const CW = LIP.w - 2 * CIX, CH = LIP.h - 2 * CIY;
const centreLuma = (f, cb) => {
  const a = anchors[f];
  const ox = a.nx + LIP_O.dx + CIX - RX, oy = a.ny + LIP_O.dy + CIY - RY, fb = f * FRAME;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const xx = ox + x, yy = oy + y;
    if (xx >= 0 && xx < RW && yy >= 0 && yy < RH) cb(raw[fb + yy * RW + xx]);
  }
};
const allLuma = [];
for (let f = 0; f < N; f += 3) centreLuma(f, (v) => allLuma.push(v));
allLuma.sort((a, b) => a - b);
const DARK_T = allLuma[(allLuma.length * 0.20) | 0];
const darkFrac = [];
for (let f = 0; f < N; f++) {
  let d = 0, n = 0;
  centreLuma(f, (v) => { if (v < DARK_T) d++; n++; });
  darkFrac.push({ f, d: n ? d / n : 0 });
}

function discriminantFrom(closedIdx, openIdx) {
  const mean = (list) => {
    const o = new Float64Array(LIP_N);
    for (const f of list) for (let i = 0; i < LIP_N; i++) o[i] += vecs[f][i] / list.length;
    return o;
  };
  const mc = mean(closedIdx), mo = mean(openIdx);
  const w = new Float64Array(LIP_N);
  let wn = 0;
  for (let i = 0; i < LIP_N; i++) { w[i] = mo[i] - mc[i]; wn += w[i] * w[i]; }
  wn = Math.sqrt(wn) || 1;
  for (let i = 0; i < LIP_N; i++) w[i] /= wn;
  return vecs.map((v) => { let d = 0; for (let i = 0; i < LIP_N; i++) d += v[i] * w[i]; return d; });
}

const K = Math.max(5, Math.round(N * 0.03));
const byDark = [...darkFrac].sort((a, b) => a.d - b.d);
let proj = discriminantFrom(byDark.slice(0, K).map((r) => r.f), byDark.slice(-K).map((r) => r.f));
// one refinement pass: re-pick exemplars from the discriminant's own extremes
{
  const byProj = proj.map((p, f) => ({ f, p })).sort((a, b) => a.p - b.p);
  proj = discriminantFrom(byProj.slice(0, K).map((r) => r.f), byProj.slice(-K).map((r) => r.f));
}
const pLo = Math.min(...proj), pHi = Math.max(...proj);
const openness = proj.map((p) => (pHi - pLo > 1e-9 ? (p - pLo) / (pHi - pLo) : 0));

// ── 3. pick the bank: span the openness range, prefer pose-consistent frames ─
// Two competing wants: an EVENLY SPACED ladder of mouth shapes, and a
// CONSISTENT head pose across the bank (so the patches agree with each other
// and with the frames they are painted over). Pose is handled as a FLOOR, not
// as the sort key — sorting by max NCC threw away her widest mouths (NCC 0.967)
// in favour of a barely-more-frontal near-closed frame (NCC 0.989), which is a
// terrible trade for lip-sync. So: keep only frames clearing the pose floor,
// then take the one nearest the band CENTRE for an even ladder.
const POSE_FLOOR = 0.93;
const chosen = [];
for (let b = 0; b < BANK_COUNT; b++) {
  const lo = b / BANK_COUNT, hi = (b + 1) / BANK_COUNT, mid = (lo + hi) / 2;
  const pool = [];
  for (let f = 0; f < N; f++) {
    const o = openness[f];
    if (o >= lo && (o < hi || (b === BANK_COUNT - 1 && o <= hi))) pool.push(f);
  }
  if (!pool.length) continue;                       // band genuinely empty — skip it
  const frontal = pool.filter((f) => anchors[f].ncc >= POSE_FLOOR);
  const f = frontal.length
    ? frontal.sort((p, q) => Math.abs(openness[p] - mid) - Math.abs(openness[q] - mid))[0]
    : pool.sort((p, q) => anchors[q].ncc - anchors[p].ncc)[0];
  if (!chosen.some((c) => c.frame === f)) {
    chosen.push({ frame: f, openness: openness[f], ncc: anchors[f].ncc, pool: pool.length });
  }
}
chosen.sort((a, b) => a.openness - b.openness);
if (chosen.length < 2) {
  console.error("refusing: could not find at least 2 distinct openness levels in this clip");
  process.exit(1);
}

// ── 4. emit ────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });

const boxFor = (f) => {
  // clamp the patch box inside the frame so ffmpeg's crop can never fail
  const x = Math.round(Math.min(Math.max(0, sx[f] + PATCH_O.dx), meta.width - PATCH.w));
  const y = Math.round(Math.min(Math.max(0, sy[f] + PATCH_O.dy), meta.height - PATCH.h));
  return { x, y, w: PATCH.w, h: PATCH.h };
};

const frames = [];
chosen.forEach((c, i) => {
  const box = boxFor(c.frame);
  const id = `v${String(i).padStart(2, "0")}`;
  const file = `${id}.png`;
  execFileSync(FFMPEG, [
    "-v", "error", "-y", "-i", CLIP,
    "-vf", `select=eq(n\\,${c.frame}),crop=${box.w}:${box.h}:${box.x}:${box.y}`,
    "-vsync", "0", "-frames:v", "1", path.join(OUT_DIR, file),
  ]);
  frames.push({
    id, file: `/avatar/visemes/${file}`,
    openness: Number(c.openness.toFixed(4)),
    sourceFrame: c.frame,
    poseConfidence: Number(c.ncc.toFixed(4)),
  });
});

const bank = {
  version: 1,
  source: "/avatar/clips/talking.mp4",
  width: PATCH.w,
  height: PATCH.h,
  fps: meta.fps,
  frames,
};
writeFileSync(path.join(OUT_DIR, "bank.json"), JSON.stringify(bank, null, 2) + "\n");

const track = {
  fps: meta.fps,
  // HONEST PROVENANCE: this track is measured, not assumed. `method` says how.
  method: "ncc-nose-template-sequential",
  note:
    "Per-frame mouth box, derived by normalised-cross-correlation tracking of a RIGID nose " +
    "template (the nose does not deform while speaking) with a sequential warm start, then " +
    "5-tap temporal smoothing of the box position. `confidence` is the raw NCC at that frame: " +
    "it falls when her head rotates away from the reference pose, which is exactly when a " +
    "frontal mouth patch would look wrong — the runtime treats it as a pose gate and skips " +
    "patching below its threshold. NOT a landmark model; there is no face-landmark dependency.",
  confidenceIsNcc: true,
  frames: anchors.map((a, f) => {
    const b = boxFor(f);
    return { x: b.x, y: b.y, w: b.w, h: b.h, confidence: Number(a.ncc.toFixed(4)) };
  }),
};
writeFileSync(path.join(OUT_DIR, "anchor.json"), JSON.stringify(track) + "\n");

// ── report ─────────────────────────────────────────────────────────────────
console.log(`\nbank: ${frames.length} frames, each ${PATCH.w}x${PATCH.h}px native, -> ${path.relative(ROOT, OUT_DIR)}/`);
for (const f of frames) {
  console.log(`  ${f.id}  openness=${f.openness.toFixed(3)}  srcFrame=${f.sourceFrame}  poseNCC=${f.poseConfidence.toFixed(3)}  ${f.file}`);
}
const os = frames.map((f) => f.openness);
console.log(`openness spread: ${Math.min(...os).toFixed(3)} .. ${Math.max(...os).toFixed(3)} (delta ${(Math.max(...os) - Math.min(...os)).toFixed(3)})`);
const gated = track.frames.filter((f) => f.confidence >= 0.93).length;
console.log(`anchor.json: ${track.frames.length} frames, ${gated} (${(100 * gated / track.frames.length).toFixed(1)}%) at confidence >= 0.93 (the runtime's default pose gate)`);
console.log(`\nwrote ${path.relative(ROOT, OUT_DIR)}/bank.json and ${path.relative(ROOT, OUT_DIR)}/anchor.json`);
