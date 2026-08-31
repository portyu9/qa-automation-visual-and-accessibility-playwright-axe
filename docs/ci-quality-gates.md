# CI quality gates

## CI workflow

### `quality`

Runs before browser-heavy jobs can be considered healthy:

- `npm ci` from the committed lockfile;
- Prettier check;
- ESLint with zero warnings allowed;
- TypeScript `--noEmit` type check;
- `npm audit --audit-level=critical`.

### `accessibility`

Installs Chromium and runs the accessibility + combined-quality suite. The job uploads Playwright reports/results even on failure, including axe JSON/Markdown attachments and traces/screenshots when available.

### `smoke`

A matrix runs the smoke suite independently on Chromium, Firefox, and WebKit. This gives inexpensive compatibility coverage without multiplying every visual baseline across browser engines.

### `visual`

Runs on pull requests. It requires `actions: read` only because it must locate and download the canonical baseline produced for the exact pull-request base SHA.

The job:

1. resolves the successful `Visual Baseline` workflow run for the exact base commit;
2. downloads its snapshot artifact;
3. installs Chromium;
4. compares desktop and mobile Chromium states;
5. preserves failure evidence;
6. if and only if the `visual-change-approved` PR label is present, generates a candidate baseline after a mismatch and verifies it in a clean second pass.

The visual job is skipped on ordinary `main` pushes because the dedicated baseline workflow owns canonical generation there.

### `quality-gate`

This aggregation job runs with `if: always()` and inspects upstream job conclusions. It is the recommended branch-protection status because its name remains stable when matrices or implementation jobs evolve.

## Visual Baseline workflow

The dedicated workflow generates canonical snapshots on every `main` commit, on a weekly refresh, and on manual dispatch. It verifies the generated snapshot set is non-empty, reruns the visual suite against the just-created baselines, and uploads snapshots plus a report.

A baseline is considered canonical only if this workflow run is successful.

## Security workflow

Security analysis is isolated because it requires different token permissions:

- CodeQL for JavaScript/TypeScript on pushes, same-repository PRs, and a scheduled cadence (fork PRs are skipped because their tokens cannot receive `security-events: write`);
- dependency review on pull requests to block newly introduced vulnerable dependencies according to the configured severity threshold.

Dependabot separately proposes npm and GitHub Actions updates. Action references in workflow source remain full commit SHAs; Dependabot can update those SHA pins while comments preserve the human-readable release.

## Artifact taxonomy

| Artifact | Created by | Purpose |
| --- | --- | --- |
| `accessibility-report-*` | accessibility job | HTML/JUnit/test evidence with axe attachments |
| `smoke-report-*` | smoke matrix | Cross-browser failure evidence |
| `visual-review-*` | PR visual job | Expected/actual/diff evidence from the base comparison |
| `visual-candidate-*` | approved PR visual path | Candidate snapshots generated after explicit approval |
| `visual-baselines-linux-chromium` | baseline workflow | Canonical snapshot tree for a `main` SHA |
| `visual-baseline-report-*` | baseline workflow | Proof that generated canonical snapshots self-verify |

Artifact names include run or project context where needed to prevent matrix collisions.

## Permissions

Workflows begin with `contents: read` or an empty permission set and grant extra rights per job. Browser-test jobs never receive repository write access. CodeQL gets `security-events: write`; the PR visual job gets `actions: read` only for cross-run artifact retrieval.

## Branch protection

Recommended required statuses:

- `CI / quality-gate`
- CodeQL analysis result

Also create the `visual-change-approved` label and ensure only trusted maintainers can apply it. Restrict bypass permissions to the same trusted group.

Use required reviews and CODEOWNERS in addition to automation. CI can prove tests ran and policy conditions were met; it cannot replace human approval of intended UX changes.
