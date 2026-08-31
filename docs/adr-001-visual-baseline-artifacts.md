# ADR-001: Store canonical visual baselines as CI artifacts

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Playwright screenshot assertions require expected PNGs. Common storage choices are committing those images to Git, using an external visual-testing service, or storing them in CI-managed object/artifact storage.

Committed PNGs make review provenance simple but create binary repository churn, inflate clones/history, and encourage developers on different operating systems to overwrite canonical images accidentally. An external service can provide excellent review UX but introduces a vendor dependency and credentials that are unnecessary for this self-contained framework.

## Decision

Canonical baselines are generated on GitHub-hosted Linux runners by a dedicated `Visual Baseline` workflow and stored as GitHub Actions artifacts.

Every pull request compares against the artifact produced for its **exact base commit SHA**, not merely the latest successful `main` run.

Local snapshots remain git-ignored and are treated as developer feedback only.

## Consequences

### Positive

- Git history stays text-focused and does not accumulate screenshot binaries.
- Canonical rendering is produced by one controlled OS/browser environment.
- Baseline provenance is linked to a workflow run and commit SHA.
- PR comparisons avoid cross-PR races by binding to the exact base SHA.
- Intentional visual changes can be reviewed through retained failure artifacts before the new `main` baseline is produced.

### Negative

- Baselines are subject to GitHub artifact retention.
- PR CI requires `actions: read` permission and the GitHub CLI to locate a prior run.
- A missing/expired exact-SHA artifact blocks visual comparison until the base is refreshed or a controlled baseline recovery is performed.
- GitHub's artifact UI is less specialized than a dedicated visual review product.

## Mitigations

- Generate a baseline on **every** `main` push.
- Run a weekly refresh for the current base.
- Retain canonical snapshot artifacts for the maximum policy-selected window used by this repository.
- Fail closed when the exact base artifact is unavailable; never silently compare against a different commit.
- Preserve actual/expected/diff evidence on failed PR comparisons.
- Require an explicit maintainer approval signal for an intentional visual mismatch before a candidate is accepted by CI.

## Reconsider when

Adopt a dedicated visual platform when requirements include large-scale cross-browser image matrices, hosted stakeholder approval, long-term baseline retention, perceptual/AI diffing, or analytics that outweigh the added vendor and credential surface.
