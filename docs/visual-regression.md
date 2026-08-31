# Visual regression strategy

## What the visual suite protects

Visual tests cover states where pixel-level changes provide meaningful regression signal: page composition, responsive layout, typography, spacing, clipping, component styling, focus/error presentation, dialogs, and selected states.

Do not snapshot every possible DOM state. A baseline is a review contract with maintenance cost; protect states whose unintended visual movement would matter to a user.

## Determinism before tolerance

The shared configuration fixes:

- browser/project identity;
- viewport/device descriptors;
- locale (`en-US`);
- timezone (`UTC`);
- light color scheme;
- reduced motion;
- CSS-pixel screenshot scale;
- hidden caret and disabled animations during comparison.

The visual helper also waits for `document.fonts.ready`. Elements whose values are truly nondeterministic can opt into masking with `data-visual-dynamic`.

When a snapshot flakes, investigate unstable data, asynchronous rendering, animation, fonts, remote assets, or viewport assumptions before changing thresholds.

## Baseline storage decision

Canonical baselines are GitHub Actions artifacts, not committed PNGs. See [ADR-001](adr-001-visual-baseline-artifacts.md) for the trade-off analysis.

The key invariant is **exact base SHA matching**. A pull request queries successful `Visual Baseline` runs for `github.event.pull_request.base.sha`; if no canonical artifact exists for that exact commit, the visual job fails with a remediation message rather than comparing against a guess.

This avoids a subtle race in fast-moving repositories: PR A should not suddenly compare itself with screenshots from PR B merely because B merged first.

## Intentional visual changes

A visual mismatch is red by default. The failing Playwright output is preserved for review.

For a deliberate visual update:

1. inspect the actual/expected/diff evidence in the PR's `visual-review-*` artifact;
2. verify the product change is intentional and accessibility behavior remains correct;
3. an authorized maintainer applies the `visual-change-approved` label;
4. the PR workflow reruns because label changes are included in its trigger;
5. CI first performs the original comparison again and preserves those diffs;
6. when the comparison fails and approval is present, CI regenerates a candidate baseline from the PR and reruns the visual suite against it;
7. merge only after normal code review and all other gates pass;
8. the merge commit's `Visual Baseline` workflow becomes the new canonical source.

The label is an audit signal, not a substitute for branch-protection review. Configure repository permissions so only trusted maintainers can apply approval labels or bypass required checks.

## Local workflow

Local snapshots are developer feedback and are git-ignored because OS/browser rendering can differ from Linux CI.

```bash
npm run visual:update
npm run test:visual
```

Use local diffs to iterate quickly. Use the GitHub-hosted artifact comparison as the merge decision.

## Artifact retention

GitHub artifacts expire. The baseline workflow runs:

- on every `main` push, guaranteeing a baseline for each merge SHA;
- on a weekly schedule, refreshing the current `main` baseline before the configured retention window expires;
- on manual dispatch for recovery or infrastructure investigation.

The scheduled run also protects long-lived branches whose base commit remains current for an extended period. If a PR base SHA is older than the retention window and no artifact remains, update the branch base or explicitly rerun the baseline workflow for the required commit through a controlled recovery process.

## Review checklist for a visual diff

Confirm that:

- the changed pixels correspond to the intended requirement;
- unrelated components are unchanged;
- desktop and mobile behavior are both acceptable;
- focus/error/selected states still communicate state visually;
- text is not clipped or reflowed unexpectedly;
- no dynamic data leaked into the baseline;
- an accessibility semantic regression is not being hidden by a visually acceptable rendering;
- the approval signal is only applied after reviewing retained diff evidence.
