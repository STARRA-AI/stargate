# Funding Intel

STARGATE now carries a first-pass funding-intel registry under `Tools`.

This slice is grounded in the unified spec:

- Book 1 says STARGATE should surface real operator data on the deck and in tool panels.
- Book 1 also says connectors must show clear status and remain honest about what is live vs. available.
- Book 2 centers money-making, fundability, and capital access as core operator work.

## Current stance

The current module does **not** pretend these repositories are live databases.
It normalizes them as one of:

- `curated_list`
- `structured_registry`
- `runtime_tool`
- `low_signal`

Each source is then marked as:

- `accepted` for immediate use with no keys
- `future_hook` when separate credentials/runtime are required
- `rejected` when the signal is weak or the repo is really a separate product

## Accepted now

- `nayafia/microgrants`
- `weecology/ogrants`
- `opensource-observer/oss-funding`
- `yueyueL/awesome-grants`
- `swyxio/devtools-angels`
- `soGeneri/awesome-launch`

## Future hooks

- `georgetown-cset/funder-finder`
- `aiassistsecure/angel`

These now map to dormant key slots in Settings so STARGATE can grow into deeper pulls later without changing the operator surface.

## Excluded

- `Dessiidoo/Fund-Flow-AI`

Reason: it reads as a separate fundraising CRM scaffold rather than a trustworthy source registry for STARGATE intake.

## Source intelligence

The underlying funding intel — 17 backyard banks/credit unions, soft-pull prequal options, bureau-reporting behavior, and the application sequence — lives in [`BACKYARD_BANKS_AND_SOFT_PULL_FUNDING.md`](./BACKYARD_BANKS_AND_SOFT_PULL_FUNDING.md). This file is the *surface* (the Tools-panel registry); that one is the *source*.

Every rate, bureau pull, and membership rule there is a LEAD dated 2026-07-27, not a current fact. Verify with the institution before acting on it.
