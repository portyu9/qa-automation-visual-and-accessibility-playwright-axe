# Architecture

## Objective

The framework makes visual regression and accessibility testing reusable quality capabilities rather than isolated scripts. A browser state worth protecting visually is often also a state worth checking semantically, but each signal keeps its own failure semantics and evidence.

## Layers

### Runtime configuration

`framework/config.ts` is the environment boundary. Port values must be complete integers in the valid TCP range. `BASE_URL` must be an absolute HTTP(S) URL and cannot embed credentials, query state, or fragments. Pure contract tests exercise these rules without requiring a browser so configuration defects fail before navigation or product behavior is involved.

### Playwright configuration

The shared Playwright configuration owns browser projects, deterministic rendering inputs, retry/worker policy, reporters, evidence capture, the local web server, and snapshot-path conventions. Browser-specific test code should be rare; projects are the primary compatibility mechanism.

Chromium owns the full feature surface. Firefox and WebKit provide a deliberately smaller smoke compatibility dimension. Mobile Chromium participates in visual/integration coverage so responsive baseline behavior is governed without multiplying canonical snapshots across every engine.

### Fixtures

Feature tests import the project fixture, which provides:

- `a11y`: a test-scoped accessibility auditor bound to the current `Page` and `TestInfo`;
- `visual`: a visual assertion helper that centralizes font readiness and dynamic-region masking;
- an automatic reduced-motion environment for browser quality tests.

Pure framework contracts may import Playwright's base `test` directly when browser fixtures are intentionally unnecessary. This keeps configuration contracts fast and prevents a helper test from depending on a browser merely because product tests do.

### Accessibility domain

The accessibility policy owns the WCAG tag set and exclusion contract. The auditor:

1. validates exclusions before execution;
2. configures axe for the repository's WCAG A/AA tags;
3. explicitly enables target-size coverage;
4. applies include regions and time-bounded exclusions;
5. runs the scan;
6. attaches JSON and Markdown evidence to Playwright;
7. returns machine-readable results for test-specific assertions;
8. throws a concise failure containing rule IDs, affected targets, impact, and help links when violations remain.

Keyboard/focus expectations stay in tests because they encode interaction semantics that axe cannot infer reliably. Incomplete axe checks remain visible in evidence and require human review rather than being silently treated as passes.

### Visual domain

The visual helper waits for browser font readiness and masks only elements carrying the explicit dynamic-content contract. The project fixture emulates reduced motion; Playwright also disables animations and hides carets during screenshot comparison.

Playwright's native matcher owns capture, baseline comparison, diff generation, and failure artifacts. Global tolerances remain intentionally narrow. A noisy test should first be stabilized through deterministic data/state/fonts/motion or a targeted mask; widening suite-wide tolerances is a last resort.

### Evidence validation

Playwright command success is necessary but not sufficient evidence that the intended suite actually ran. `scripts/validate-playwright-evidence.mjs` validates the JUnit root, numeric result metadata, minimum executed-test floors, intended-suite tokens, zero recorded errors/failures, and a non-trivial HTML report.

This catches discovery regressions such as a renamed directory, an accidentally empty matrix slice, or a reporter failure that would otherwise leave a superficially green job with weak proof.

### Reference application

The dependency-free local site is a self-test target, not a substitute for a system under test. It contains:

- skip navigation and named landmarks;
- responsive deterministic layout;
- keyboard-operable tabs;
- a native dialog and focus transition;
- a validation/error state;
- an intentionally invalid accessibility fixture that proves the harness detects known defects.

### CI orchestration

CI separates concerns:

- quality: exact npm qualification, static checks, framework contracts, evidence validation, HIGH npm advisory gate;
- accessibility: Chromium axe/state coverage plus validated evidence;
- smoke: Chromium/Firefox/WebKit compatibility plus per-engine validated evidence;
- visual: exact-base-SHA baseline retrieval, comparison, approval policy, candidate verification, and comparison evidence;
- quality-gate: stable CI aggregation;
- Visual Baseline: canonical baseline generation/verification on `main`;
- Security: CodeQL, npm advisory evidence, Trivy repository scanning, Dependency Review, and stable security aggregation.

The stable `quality-gate` and `security-gate` jobs are intended branch-rule interfaces. Internal matrices and implementation jobs can evolve without forcing repository protection settings to follow every detail.

## Data flow

```text
main commit
   │
   ├── CI ──> quality / accessibility / cross-browser evidence
   │
   ├── Security ──> source / dependency / configuration / secret evidence
   │
   └── Visual Baseline ──> canonical snapshot artifact keyed by run + commit SHA
                                  │
PR base SHA ──> locate exact successful baseline run ──> download snapshots
                                                       │
PR head ──> render same states ──> Playwright compare ─┼─> pass + validated evidence
                                                       └─> preserved diff evidence
                                                                  │
                                                  explicit maintainer approval
                                                                  │
                                                       candidate regenerate + verify
```

Intentional visual changes remain auditable because the initial comparison occurs before candidate generation and its mismatch evidence is retained separately.

## Trust boundaries

- npm dependency lifecycle scripts are disabled during CI installation;
- Playwright browser installation is explicit;
- workflow actions are immutable SHA pins;
- browser jobs are read-only with respect to repository contents;
- CodeQL alone receives `security-events: write`;
- PR baseline retrieval alone receives `actions: read`;
- Dependency Review availability is treated as a distinct GitHub service dependency;
- repository rules must require the stable CI/security aggregators for workflow success to become a merge precondition.

## Extension boundaries

Production consumers can add application-specific concerns without weakening the core policy:

- authentication/storage-state fixtures;
- API-backed test-data factories;
- page/component models where they improve readability;
- environment authorization and allowlisting;
- application-specific dynamic masks;
- WCAG exclusion registries tied to an issue system;
- external reporting integrations.

The framework layer defines **how quality is measured**; tests define **which product behavior matters**. New abstraction should own a durable policy or failure boundary rather than merely rename Playwright or axe APIs.
