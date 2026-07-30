# CI workflows — parked here on purpose

These are ready-to-run GitHub Actions files (`ci.yml`, `security.yml`). They
live in `ci/workflows/` instead of `.github/workflows/` because pushing files
under `.github/workflows/` requires a git credential with the `workflow` OAuth
scope, which this machine's stored credential does not carry — and activating
CI was not worth blocking the repo push.

To activate CI (either way works, one minute):
- On github.com: open each file here, copy it into `.github/workflows/` via
  "Add file", commit.
- Or locally, with a credential that has the scope (`gh auth login` then
  `gh auth refresh -s workflow`): `git mv ci/workflows/*.yml .github/workflows/`
  and push.

Until then they are inert — GitHub only runs workflows from
`.github/workflows/`.
