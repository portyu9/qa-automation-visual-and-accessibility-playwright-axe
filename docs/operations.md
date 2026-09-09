# Operations Guide

## Purpose

This guide owns the day-to-day operating contract for the Playwright + axe-core visual/accessibility framework: installation, runtime targets, command selection, evidence interpretation, dependency maintenance, and failure triage.

Use the focused guides for domain depth:

- [`accessibility-testing.md`](accessibility-testing.md) — axe policy, exclusions, incomplete checks, behavioral accessibility.
- [`visual-regression.md`](visual-regression.md) — determinism, screenshot policy, baseline comparison, change review.
- [`adr-001-visual-baseline-artifacts.md`](adr-001-visual-baseline-artifacts.md) — canonical baseline provenance decision.
- [`ci-quality-gates.md`](ci-quality-gates.md) — evidence validation, CI topology, baseline workflow, security gates.
- [`manual-accessibility-checklist.md`](manual-accessibility-checklist.md) — human-dependent accessibility review.

## Quick start

The qualified toolchain is **Node.js** with **npm**. `.nvmrc` pins Node and `packageManager` pins npm.

```bash
npm install --global --ignore-scripts npm@11.19.1
npm ci --ignore-scripts
npx playwright install --with-deps
npm run check
npm test
```

The default Playwright configuration starts the deterministic local application automatically.

<!-- prettier-ignore -->
| Command | Purpose |
| --- | --- |
| `npm run check` | Format, lint, types, runtime/docs/workflow-pin policy |
| `npm run test:framework` | Framework/configuration contracts |
| `npm run test:smoke` | Chromium/Firefox/WebKit critical-path compatibility |
| `npm run test:accessibility` | Chromium axe + keyboard/state accessibility |
| `npm run test:visual` | Desktop/mobile Chromium visual comparison |
| `npm run visual:update` | Generate local candidate snapshots for investigation |
| `npm test` | Full configured Playwright matrix |
| `npm run report` | Open latest Playwright HTML report |

## Runtime target policy

`BASE_URL` is parsed before browser work. It must be absolute HTTP(S) and contain no credentials, query, or fragment. `TEST_PORT` must be a complete integer in the valid TCP range.

```bash
BASE_URL=https://qa.example.internal npm run test:accessibility
```

<!-- prettier-ignore -->
| Variable | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:4173` | Approved application target |
| `TEST_PORT` | `4173` | Deterministic local-site port |
| `CI` | supplied by CI | Enables CI retry/worker/report policy |

A product integration should add environment authorization, authentication, tenancy, test-data cleanup, allowlisting, and state-changing-test policy at the integration boundary. A syntactically valid URL is not automatically an operationally approved target.

## Quality-oracle boundaries

Visual regression and accessibility intentionally answer different questions:

- Playwright image comparison asks whether governed pixels changed;
- axe asks whether configured machine-detectable accessibility rules failed;
- keyboard/focus tests ask whether selected interaction semantics work;
- cross-browser smoke asks whether critical behavior survives qualified engines;
- evidence validators ask whether the intended tests/projects/artifacts actually executed.

A visual diff is a change detector, not a correctness oracle. An axe pass is an automated rule-engine result, not WCAG certification.

## Determinism before tolerance

Before widening screenshot tolerance, control the source of entropy:

- wait for fonts;
- use reduced motion and screenshot animation/caret stabilization;
- mask only explicitly dynamic regions;
- fix locale/timezone/color preference;
- block service workers for deterministic repository execution;
- use named desktop/mobile projects;
- keep fixture data deterministic;
- scope canonical visual coverage intentionally to Chromium projects.

A broad tolerance increase is the least attributable response to visual noise and should be last, not first.

## Accessibility operating policy

The shared auditor applies governed WCAG A/AA tags and explicit target-size coverage. Violations fail unless a validated exclusion owns selector, reason/reference, and future expiry.

Incomplete axe checks remain visible for human review. Behavioral accessibility—keyboard navigation, focus restoration, dialogs, skip links, validation focus—stays in explicit Playwright tests.

Automated tooling does not replace screen-reader, cognitive, zoom/reflow, alternative-input, content-context, or other human judgment. See [`manual-accessibility-checklist.md`](manual-accessibility-checklist.md).

## Visual baseline lifecycle

Canonical snapshots are workflow artifacts rather than committed source churn. The essential contract is:

1. successful `main` SHA generates/validates canonical Chromium desktop/mobile snapshots;
2. the artifact remains tied to that exact commit;
3. a PR resolves the successful baseline for its exact base SHA;
4. PR head renders the same governed states and compares against those pixels;
5. mismatches preserve expected/actual/diff evidence before any candidate generation;
6. approved visual changes may generate candidates, which are rerun and semantically validated;
7. after merge, the new `main` SHA becomes canonical only through a fresh baseline workflow.

A PR must not redefine its expected pixels before comparison with the state it proposes to replace.

## Evidence semantics

Playwright process success is followed by repository-owned semantic validation covering:

- JUnit structure;
- zero failures/errors for successful lanes;
- intended suite identity;
- exact governed project-host attribution where required;
- minimum actually executed tests;
- skip-aware execution counts;
- non-trivial HTML evidence;
- expected PNG baseline/candidate counts.

The visual lane is governed as 12 executions across six exact visual identities on Chromium and mobile Chromium. Unknown governed evidence tokens fail closed.

This protects against renamed directories, empty matrix slices, reporter regressions, accidental discovery loss, and jobs that technically run without producing the intended quality evidence.

## CI and security

Primary CI separates framework/static quality, accessibility, cross-browser smoke, visual comparison, and the stable `quality-gate` aggregate. The Visual Baseline workflow owns canonical baseline generation/verification on `main`.

Security remains independently attributable through supply-chain policy, CodeQL, npm Audit, Trivy, and Dependency Review when GitHub Dependency graph is available. Third-party Actions are immutable-SHA pinned; CI installs dependencies with lifecycle scripts disabled and installs Playwright browsers explicitly.

For merge-enforcement naming, see the root README and [`ci-quality-gates.md`](ci-quality-gates.md).

## Confidence boundaries

<!-- prettier-ignore -->
| Signal | Confidence gained | Deliberate limit |
| --- | --- | --- |
| Canonical baseline | Expected pixels are traceable to accepted repository history | Does not prove design correctness/usability/accessibility |
| Exact-base comparison | PR compares against its actual base revision | Pixel oracle is still non-semantic |
| Visual thresholds | Small rendering noise can be tolerated under explicit policy | Can hide meaningful small changes or flag harmless differences |
| axe scan | Rendered DOM/accessibility state is evaluated against configured automated rules | Does not cover every accessibility requirement or human judgment |
| Keyboard/focus contracts | Selected focus/operability behaviors are executable | Not complete assistive-technology qualification |
| Cross-browser smoke | Critical behavior survives explicitly qualified engines | Not complete engine/device/platform equivalence |
| Known-violation harness | Accessibility oracle demonstrably detects governed invalid fixtures | Does not prove sensitivity to every real defect |
| Retry + flaky-test failure | Retry diagnostics exist without normalizing recovered flakiness | Does not diagnose root cause |
| Screenshot/report/trace | Failures retain attributable execution context | Artifacts can expose application/session data |
| CodeQL/npm Audit/Trivy/Dependency Review | Independent security planes are inspected | Green scanners are scoped evidence, not proof of vulnerability absence |

## Dependency maintenance

Dependencies are exact-pinned in `package.json` and reproduced through `package-lock.json`. Dependabot owns npm and GitHub Actions update proposals.

Automated dependency changes still must satisfy runtime/static checks, framework contracts, browser execution, semantic evidence, security scanning, and visual-governance rules applicable to the change.

The TypeScript major line remains constrained until the installed `typescript-eslint` line declares support for a newer major; compatible minor/patch maintenance remains enabled.

## Failure triage

<!-- prettier-ignore -->
| Signal | First interpretation |
| --- | --- |
| Framework contract | Harness/configuration policy |
| axe violation | Detectable accessibility rule failure |
| Keyboard/focus | Interaction/focus-management regression |
| Visual mismatch | Governed pixels changed; review intent before expectations |
| Cross-browser-only | Engine compatibility/timing/rendering difference |
| Missing exact-base baseline | Baseline provenance/retention, not permission to use another SHA |
| Evidence validator | Intended tests/projects/artifacts not proven |
| npm Audit / Trivy / CodeQL | Independent security plane |
| Dependency Review unavailable | GitHub service capability gap; other scans are not equivalent |

## Extension boundaries

Production consumers may add auth/storage-state fixtures, API-backed data lifecycle, meaningful page/component models, environment authorization/allowlists, application-specific dynamic masks, issue-linked accessibility debt, manual/screen-reader evidence, and external observability/release integrations.

New abstraction should own a durable quality policy, lifecycle, safety boundary, or evidence contract. Merely renaming Playwright or axe APIs adds indirection without increasing quality.
