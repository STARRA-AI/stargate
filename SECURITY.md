# Security Policy

STARGATE is a private project operated by STARRA LLC. This document covers how to
report a vulnerability and what automated protection the repository runs.

## Reporting a vulnerability

**Do not open a public issue or pull request for a security problem.**

- Preferred: GitHub → **Security** tab → **Report a vulnerability** (private
  advisory) on this repository.
- Otherwise: contact the maintainer directly.

Please include the affected file/route, reproduction steps, impact, and any known
fix. We aim to acknowledge within 72 hours.

## Secrets

Runtime secrets never live in the repo. `data/keys.json`, `.env.local`, and the
`data/` runtime tree are gitignored, and CI scans the **full git history** for
leaked secrets (gitleaks) on every push and PR. If a key is ever exposed, rotate
it first, then purge it from history.

## Automated coverage

| Layer | Tool | Runs |
|-------|------|------|
| Dependency vulnerabilities | Dependabot alerts + version updates | continuous / weekly |
| Dependency gate | `npm audit --audit-level=high` | every push + PR (`Security` workflow) |
| Secret scanning | gitleaks (full history) | every push + PR |
| Static analysis (SAST) | Semgrep | every push + PR (non-blocking) |
| Code review | CodeRabbit | every PR |
| Quality gate | typecheck · lint · test · build | every push + PR (`CI` workflow) |

The `Security` workflow also runs a weekly scheduled sweep to catch newly
disclosed vulnerabilities in unchanged dependencies.

## Known residuals

- `@hono/node-server` (moderate, Windows-only path traversal) is pulled in
  transitively by the `repomix` dev tool (`repomix → @modelcontextprotocol/sdk →
  @hono/node-server`). It is a development dependency that never ships in the
  app, and the only current fix downgrades `repomix`. Tracked by Dependabot;
  will clear when `repomix` ships on `@hono/node-server >= 2.0.5`.

## Supported

`main` and the active working branch. Security fixes land on `main` first.
