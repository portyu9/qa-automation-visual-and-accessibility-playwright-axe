# Architecture

## Objective

The framework makes visual regression and accessibility testing first-class, reusable capabilities rather than isolated test scripts. It is designed around a simple rule: a browser state worth visually protecting is often also a state worth checking semantically.

## Layers

### Playwright configuration

The shared Playwright configuration owns browser projects, deterministic rendering inputs, retry/worker policy, reporters, evidence capture, the local web server, and snapshot path conventions. Browser-specific test code should be rare; projects are the primary compatibility mechanism.

### Fixtures

Tests import the project fixture instead of importing Playwright's base test directly. The fixture provides two domain helpers:

- `a11y`: a test-scoped accessibility auditor bound to the current `Page` and `TestInfo`;
- `visual`: a visual assertion helper that centralizes font readiness and masking.

Keeping helpers in fixtures makes policy hard to bypass accidentally and avoids repeating test plumbing.

### Accessibility domain

The accessibility policy contains the WCAG tag set and exclusion contract. The auditor:

1. validates exclusions before execution;
2. configures axe to run only the project's WCAG A/AA tags;
3. explicitly enables target-size coverage;
4. applies include regions and time-bounded exclusions;
5. runs the scan;
6. attaches JSON and Markdown evidence to the Playwright test;
7. throws an assertion failure with rule IDs, nodes, selectors, impact, and help links when violations remain.

Keyboard/focus expectations stay in tests because they encode application interaction semantics that axe cannot infer reliably.

### Visual domain

The visual helper prepares the page for capture by waiting for browser font readiness and masking elements marked as dynamic. Playwright's native screenshot matcher provides image capture, baseline comparison, diff generation, and failure artifacts.

Global tolerances are intentionally narrow. A noisy test should first be made deterministic with stable data, state, fonts, animation suppression, or a targeted mask; loosening suite-wide thresholds is a last resort.

### Reference application

The dependency-free site is a self-test target, not a substitute for a system under test. It contains:

- skip navigation and named landmarks;
- responsive cards and deterministic layout;
- keyboard-operable tabs;
- a native dialog;
- a validation/error state;
- an intentionally invalid accessibility fixture used to prove the harness fails defects.

### CI orchestration

CI separates concerns:

- quality job: formatting, linting, type checking, npm audit;
- accessibility job: Chromium axe/state suite;
- smoke matrix: Chromium, Firefox, WebKit;
- visual PR job: exact-base-SHA baseline retrieval and comparison;
- visual baseline workflow: canonical baseline generation on `main`;
- security workflow: CodeQL and dependency review.

The `quality-gate` aggregation job is stable even when internal matrices change, which makes branch-protection configuration durable.

## Data flow

```text
main commit
   │
   ├── CI ──> code/a11y/smoke validation
   │
   └── Visual Baseline ──> canonical snapshot artifact keyed by workflow run + commit SHA
                                  │
PR base SHA ──> locate exact successful baseline run ──> download snapshots
                                                       │
PR head ──> render same states ──> Playwright compare ─┼─> pass
                                                       └─> diff/report evidence
```

Intentional visual changes remain auditable: the initial comparison still runs and its failure evidence is preserved before an approved candidate baseline is generated.

## Extension boundaries

Production consumers can add product-specific abstractions without changing the core policy:

- authentication or storage-state fixtures;
- API-backed test-data factories;
- page/component models where they improve readability;
- environment capability discovery;
- application-specific dynamic masks;
- WCAG exclusion registries tied to an issue system;
- external reporting integrations.

The framework layer should remain application-agnostic. It defines _how quality is measured_; tests define _which product behavior matters_.
