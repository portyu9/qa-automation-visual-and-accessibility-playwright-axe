# CI quality gates

## Runtime contract

GitHub-hosted jobs use Node.js 24.20.0 LTS and explicitly qualify npm 11.19.1 before installing the repository. Dependency installation uses `npm ci --ignore-scripts`; browser binaries are installed explicitly through Playwright so dependency lifecycle scripts do not become an implicit execution boundary.

## CI workflow

### `quality`

The fast quality lane runs before browser-heavy coverage can be considered healthy:

- exact npm runtime check;
- lockfile install with lifecycle scripts disabled;
- Prettier check;
- ESLint with zero warnings;
- TypeScript `--noEmit` check;
- browser-independent framework/runtime configuration contracts;
- semantic validation of Playwright JUnit/HTML evidence, including a minimum executed-test count;
- `npm audit --audit-level=high`.

Framework evidence is retained for triage. The test command remains authoritative; artifact/report generation cannot turn a failed command into success.

### `accessibility`

The job installs Chromium and runs the accessibility suite. A successful test command is followed by semantic evidence validation that requires:

- a valid Playwright `<testsuites>` JUnit root;
- at least 11 executed tests at the current coverage floor;
- zero recorded JUnit failures/errors;
- an accessibility-suite token proving the intended directory was discovered;
- a non-trivial HTML report.

The retained Playwright report embeds axe JSON/Markdown attachments. Upload runs even when earlier steps fail so available diagnostics survive the failure.

### `smoke`

Chromium, Firefox, and WebKit run independently. Every engine must execute the committed smoke contract and produce meaningful JUnit/HTML evidence. Reports are retained on success as well as failure so the matrix has inspectable proof rather than only a green job conclusion.

### `visual`

The pull-request visual lane has `actions: read` so it can locate and download the canonical baseline generated for the exact pull-request base SHA.

The job:

1. resolves the successful `Visual Baseline` workflow for `github.event.pull_request.base.sha`;
2. fails closed if that exact baseline cannot be found;
3. downloads its snapshot artifact;
4. installs Chromium explicitly;
5. compares desktop and mobile Chromium states;
6. preserves Playwright comparison evidence;
7. fails an unapproved visual mismatch;
8. if `visual-change-approved` is present, preserves the original mismatch, regenerates a clean candidate, reruns the visual suite, and validates successful evidence for at least 12 executed visual/integration project cases;
9. uploads the approved candidate separately from the original comparison evidence.

The visual job is skipped on ordinary `main` pushes because canonical generation belongs to the dedicated baseline workflow.

### `quality-gate`

This stable aggregation job runs with `if: always()` and evaluates the upstream conclusions explicitly. Pull requests require quality, accessibility, smoke, and visual success. Non-PR events require the non-visual lanes while accepting the deliberately skipped PR-only visual job.

Use the aggregator as the durable required CI status instead of coupling repository rules to every implementation job or matrix member.

## Visual Baseline workflow

Canonical snapshots are generated on each `main` commit, weekly refresh, and manual dispatch. The workflow:

1. qualifies the exact Node/npm runtime;
2. performs a script-disabled lockfile install;
3. installs Chromium explicitly;
4. generates desktop/mobile snapshots;
5. reruns the visual suite against the generated set;
6. validates successful JUnit/HTML execution evidence;
7. requires at least 12 PNG snapshots at the current baseline floor;
8. uploads the canonical snapshot tree and verification report.

A baseline is canonical only when this workflow run is successful. The snapshot artifact is therefore tied to both a GitHub workflow run and a specific commit SHA.

## Security workflow

Security controls are independent because their scopes and token permissions differ.

### CodeQL

JavaScript/TypeScript uses CodeQL `security-extended`. Same-repository pull requests, pushes, schedules, and manual runs are analyzed. Fork pull requests skip CodeQL because an untrusted fork token cannot receive `security-events: write`; the stable security aggregator accounts for that deliberate permission boundary.

### npm advisory gate

The job performs a clean script-disabled install and then runs `npm audit --audit-level=high --json`. The JSON must exist and contain vulnerability metadata. HIGH/CRITICAL policy failures retain npm's non-zero status, while the report and summary are preserved for triage.

### Trivy repository gate

Trivy scans the repository filesystem with vulnerability, misconfiguration, and secret scanners. Fixed HIGH/CRITICAL dependency findings, supported HIGH/CRITICAL configuration findings, and gated secret findings retain a non-zero scan result. JSON evidence and a concise summary are preserved independently from npm Audit.

### Dependency Review

Pull requests probe GitHub Dependency graph availability before invoking the official Dependency Review action. When available, dependency changes fail at HIGH severity or above.

When Dependency graph is unavailable, the workflow records the missing diff-aware service and does **not** claim npm Audit or Trivy are equivalent replacements. The independent npm and Trivy jobs still gate the committed graph/repository; enabling Dependency graph restores the stronger change-aware PR control.

### `security-gate`

The stable security aggregator requires:

- npm Audit success;
- Trivy success;
- CodeQL success when token permissions permit CodeQL to run;
- Dependency Review success for pull requests (including the explicit service-availability handling inside that job).

This gives branch protection one durable security status while keeping the underlying controls independently observable.

## Dependabot

Dependabot proposes npm and GitHub Actions updates on a weekly schedule. Workflow action references remain immutable full commit SHAs; Dependabot may update those pins while comments preserve the human-readable release.

TypeScript semver-major updates remain ignored until the installed `typescript-eslint` line declares compatibility with the target TypeScript major. This avoids automated PRs that violate a known peer-support boundary while leaving normal minor/patch maintenance enabled.

## Artifact taxonomy

- `framework-report-*` — framework/runtime contract JUnit + HTML evidence.
- `accessibility-report-*` — accessibility JUnit/HTML evidence containing axe attachments.
- `smoke-report-<browser>-*` — per-engine smoke proof and failure diagnostics.
- `visual-comparison-*` — PR comparison JUnit/HTML/test-result evidence on both passing and failing comparisons.
- `visual-review-*` — preserved expected/actual/diff state from an intentional or unapproved mismatch.
- `visual-candidate-*` — candidate snapshots generated only after explicit visual-change approval.
- `visual-baselines-linux-chromium` — canonical desktop/mobile snapshot tree for a successful baseline workflow run.
- `visual-baseline-report-*` — proof that generated canonical snapshots self-verified.
- `npm-audit-evidence-*` — machine-readable npm advisory evidence.
- `trivy-security-evidence-*` — machine-readable Trivy scan evidence and summary.

Artifact names include run, project, or PR context where needed to prevent matrix collisions.

## Permissions

Workflows begin with `contents: read`. Browser-test jobs never receive repository write access. CodeQL receives `security-events: write`; the PR visual job receives `actions: read` only for cross-run baseline retrieval. Third-party action references use immutable commit SHAs.

## Merge enforcement

A green workflow is advisory unless repository rules require it. Configure the `main` ruleset to require at minimum:

- pull requests;
- `CI / quality-gate`;
- `Security / security-gate`;
- human approval appropriate to repository ownership;
- Code Owner review for workflow/security-sensitive changes;
- stale-approval dismissal after new commits;
- review-thread resolution;
- force-push and deletion protection;
- tightly scoped or no bypass privileges.

Also enable GitHub Dependency graph for full Dependency Review coverage and create `visual-change-approved` with application privileges limited to trusted maintainers.

Repository-rule configuration is part of the framework's operational boundary. CI can prove a control ran; only branch/ruleset enforcement can make that result a merge precondition.
