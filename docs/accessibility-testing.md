# Accessibility testing

## Automated policy

Automated scans use `@axe-core/playwright` with these axe tags:

- `wcag2a`
- `wcag2aa`
- `wcag21a`
- `wcag21aa`
- `wcag22aa`

The `target-size` rule is explicitly enabled. The scanner can analyze the entire document or an included component/region.

Axe findings are treated as defects unless a governed exclusion applies. Every test scan emits raw JSON and a Markdown summary to the Playwright result so a CI artifact contains useful diagnostic data even when the assertion fails.

## Scan states, not only routes

A route-level scan can miss defects introduced only after interaction. Prefer scanning states whose accessibility tree changes, including:

- opened dialogs, popovers, and menus;
- validation or error states;
- expanded disclosures;
- active tab panels;
- authenticated navigation;
- disabled/loading states;
- responsive variants where DOM or semantics differ.

The combined-quality tests demonstrate running visual and accessibility checks against the same interaction state.

## Keyboard and focus

Axe cannot prove the intended keyboard model. Tests should explicitly cover keyboard interactions where the product contract depends on them, for example:

- skip-link destination and visible focus;
- tab order through high-value workflows;
- roving tab focus with arrow keys, Home, and End;
- dialog initial focus, focus containment/return as applicable, and Escape behavior;
- form error focus and programmatic error messaging;
- keyboard activation of custom controls.

Prefer semantic/native controls whenever possible; tests should not normalize an unnecessarily custom interaction model.

## Exclusion governance

An exclusion is allowed only when all of the following are supplied:

- **selector**: the smallest stable region that must be excluded;
- **reason**: why the automated failure cannot currently be resolved;
- **issue**: a durable remediation reference such as `A11Y-1234` or an issue URL;
- **expires**: ISO `YYYY-MM-DD` date.

The framework validates these fields and throws when the date is invalid or expired. Exclusions therefore fail closed instead of silently becoming permanent debt.

Example:

```ts
await a11y.assertNoViolations({
  name: 'legacy account picker',
  exclude: [
    {
      selector: '[data-legacy-account-picker]',
      reason: 'Third-party control awaiting accessible replacement',
      issue: 'A11Y-241',
      expires: '2026-11-30',
    },
  ],
});
```

Do not exclude an entire page to suppress a single component. Do not extend expiry dates without a fresh remediation decision.

## What automation cannot certify

A passing axe scan does not establish WCAG conformance. Manual and assistive-technology testing still needs to evaluate, among other things:

- whether accessible names communicate the right meaning;
- reading and focus order in actual task context;
- screen-reader announcements and interaction expectations;
- alternative text quality rather than mere presence;
- cognitive load and clarity of instructions/errors;
- usability at zoom and text-spacing settings;
- meaningful sequencing and visual/semantic relationships;
- whether motion, timing, and interruption behavior are usable;
- target usability beyond the mechanical rule threshold.

Use the [manual accessibility checklist](manual-accessibility-checklist.md) for release-level human validation.

## Handling `incomplete` results

Axe can return `incomplete` checks that require human judgment. The framework records the complete axe result JSON so those checks are reviewable, but the automated quality gate fails on confirmed `violations`, not on every `incomplete` item. Teams integrating the framework into regulated or higher-risk domains can add policy that escalates selected incomplete rule IDs for mandatory manual disposition.
