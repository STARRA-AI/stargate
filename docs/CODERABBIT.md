# CodeRabbit — debug STARGATE via PRs

Classic uses CodeRabbit as an advisory reviewer on GitHub pull requests. It does not replace operator judgment; it flags bugs, regressions, and gaps before merge.

## Setup (once)

1. Install the [CodeRabbit GitHub App](https://github.com/apps/coderabbitai) on the private `stargate` repo (or the org that owns it).
2. Grant read access to code + PR write for review comments.
3. Optional: keep `.coderabbit.yaml` at repo root (Next.js / TypeScript focus).

## Daily loop

1. Work on a **feature branch** (never push experimental HUD/brain changes straight to `main` without a PR when you want review).
2. Open a PR against `main`:
   ```bash
   git push -u origin HEAD
   /Users/work/Projects/stargate/.tools/gh pr create --title "…" --body "…"
   ```
3. Ask for a review in a PR comment:
   ```
   @coderabbitai review
   ```
4. Read the review comments. Treat high-confidence findings as bugs to fix; dismiss noise that conflicts with Book 1/2 or conference locks.
5. Push fixes to the same branch; re-request with `@coderabbitai review` if needed.
6. Merge only when green enough for the slice — no force-push to `main`.

## What to ask CodeRabbit about

- Chat hang / stream abort regressions (`/api/chat`, `brain.ts`)
- Accidental UI regressions (Eye / Bridge / `deck.css`) when the PR was not supposed to touch them
- Secrets or paths that should stay gitignored (`data/keys.json`, `.env.local`, `.tools/`, `vendor/`)

## Out of scope

CodeRabbit does not run the PWA, Multica LINK, or voice. For those, use local smoke tests and conference STATUS blocks.
