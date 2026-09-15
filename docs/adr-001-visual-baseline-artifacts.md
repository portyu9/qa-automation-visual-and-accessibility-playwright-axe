# ADR-001: Store canonical visual baselines as CI artifacts

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

Playwright screenshot assertions require expected PNGs. Common storage choices are committing those images to Git, using an external visual-testing service, or storing them in CI-managed object/artifact storage.

Committed PNGs make review provenance simple but create binary repository churn, inflate clones/history, and encourage developers on different operating systems to overwrite canonical images accidentally. An external service can provide excellent review UX but introduces a vendor dependency and credentials that are unnecessary for this self-contained framework.

## Decision

Canonical baselines are generated on GitHub-hosted Linux runners by a dedicated `Visual Baseline` workflow and stored as GitHub Actions artifacts.

Every **visual-impacting** pull request compares against the artifact produced for its exact base commit SHA, not merely the latest successful `main` run. CI classifies a pull request as non-visual only when every changed file is under `.github/` or `docs/`; any source, dependency, test, runtime, package, or other repository change requires the exact-base visual comparison. The aggregate quality gate verifies this classification and accepts a skipped visual job only for that explicit non-visual scope.

Local snapshots remain git-ignored and are treated as developer feedback only.

## Consequences

### Positive

- Git history stays text-focused and does not accumulate screenshot binaries.
- Canonical rendering is produced by one controlled OS/browser environment.
- Baseline provenance is linked to a workflow run and commit SHA.
- Visual-impacting PR comparisons avoid cross-PR races by binding to the exact base SHA.
- Workflow/documentation-only changes do not deadlock when their base lacks a screenshot artifact, while dependency/code/test changes cannot use that exemption.
- Intentional visual changes can be reviewed through retained failure artifacts before the new `main` baseline is produced.

### Negative

- Baselines are subject to GitHub artifact retention.
- Visual-impacting PR CI requires `actions: read` permission and the GitHub CLI to locate a prior run.
- A missing/expired exact-SHA artifact blocks a visual-impacting comparison until the base is refreshed or a controlled baseline recovery is performed.
- The non-visual scope classifier is part of the CI control plane and therefore requires explicit policy protection and tests.
- GitHub's artifact UI is less specialized than a dedicated visual review product.

## Mitigations

- Generate a baseline on every ordinary `main` push.
- Also generate a baseline when a completed `dependency-governance` run observes that the default branch advanced while the governance run was executing. This covers governed merges created with the workflow `GITHUB_TOKEN`, whose resulting branch update does not recursively start ordinary push-triggered workflows.
- Bind the governance-follow-up baseline to the `workflow_run` event's current default-branch `GITHUB_SHA`; visual-impacting PR comparison still accepts only a successful baseline whose recorded workflow head SHA exactly equals the PR base SHA.
- Derive visual applicability from the exact PR diff. Only `.github/**` and `docs/**` changes are non-visual; an empty/unclassifiable diff fails the scope job rather than defaulting to a skip.
- Require the aggregate quality gate to verify both the scope-classification job and the resulting visual job state.
- Keep `ci.yml`, `visual-baseline.yml`, and the dedicated trigger/applicability self-check in the dependency-governance manual-review control-plane set so the exemption and baseline provenance rules cannot change through autonomous dependency updates.
- Run a weekly refresh for the current base.
- Retain canonical snapshot artifacts for the maximum policy-selected window used by this repository.
- Fail closed when an exact base artifact is unavailable for a visual-impacting PR; never silently compare against a different commit.
- Preserve actual/expected/diff evidence on failed PR comparisons.
- Require an explicit maintainer approval signal for an intentional visual mismatch before a candidate is accepted by CI.

## Reconsider when

Adopt a dedicated visual platform when requirements include large-scale cross-browser image matrices, hosted stakeholder approval, long-term baseline retention, perceptual/AI diffing, or analytics that outweigh the added vendor and credential surface.
