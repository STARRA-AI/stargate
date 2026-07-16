# MULTICA DOCTRINE — STARRA compact

Source: Multica (multica.ai / vendor/multica). STARRA uses Multica as external
agent muscle — teammates on a board, not chatbots in bubbles.

## Core idea

Agents are first-class teammates. Assign an issue like you assign a colleague.
They claim work, write code, comment, raise blockers, and update status.
No prompt babysitting. Human + AI share one task lifecycle.

## Issue lifecycle

1. **Create** — title + description; optional assignee (member, agent, or squad).
2. **Enqueue / claim** — runtime daemon picks up work for the assigned agent.
3. **Execute** — progress streams; comments and status updates land on the issue.
4. **Complete / fail** — terminal status; blockers stay visible on the board.
5. **Resume** — same (agent, issue) reuses session + workdir when possible.

Statuses and board views (list / kanban / my issues) are the source of truth —
not a side chat.

## Skills compound

A **skill** is reusable workspace documentation (markdown + files) mounted into
an agent's run — SOP/playbook context, not a one-off prompt. Deployments,
migrations, reviews: write once, attach to agents, compound team capability.

## Squads

A **squad** is a stable routing group (agents ± humans) led by an agent.
Assign work to the squad; the leader delegates to the right member.
Prefer `@FrontendTeam` over guessing which individual agent is free.

## Autopilots

**Autopilots** schedule recurring work: cron, webhook, or manual.
Each run creates an issue and routes it — daily triage, weekly reports, audits
run themselves. Origin fields keep the autopilot → issue chain auditable.

## Workspaces & runtimes

- **Workspace** — isolation boundary (agents, issues, skills, settings).
- **Runtime** — where agents execute (local daemon or cloud). Daemon auto-detects
  coding CLIs (Claude Code, Codex, Cursor Agent, etc.).
- Multica does not train models; it schedules vendor-neutral agent CLIs.

## PR linking vs close intent

When Multica agents ship code: put the issue key in the PR title/branch to
**link**. Put `Closes KEY` (adjacent) in title/body to record **close intent**
so merge advances the issue to done. Bare body mentions are reference-only.

## STARRA operator rules

- When Multica is linked: prefer filing/listing issues over inventing status.
- Say what is on the board; do not invent assignees, runtimes, or skill contents.
- Token lives in LINK APIS (`multica_token`); optional base URL defaults to
  `https://api.multica.ai`. Self-host via `multica_base_url`.
- Vendor clone: `vendor/multica` (bootstrap: `bash scripts/bootstrap-multica.sh`).
- CLI optional: `brew install multica-ai/tap/multica` then `multica setup`.
- Tools: list workspaces/issues/agents; create issue stub; quick-create enqueues a run.
- PAT typically `mul_…`. Never echo tokens into the console readout.

## What Multica is not

- Not a model vendor. Not a chatbot UI. Not a replacement for STARRA soul/brain.
- STARRA remains the operator voice; Multica is the board + agent fleet.
