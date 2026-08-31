# Contributing

## Development setup

Use the Node.js version declared by `.nvmrc` and the npm major declared by `packageManager`.

```bash
npm ci
npx playwright install --with-deps
npm run check
npm test
```

Keep dependency versions exact. Update dependencies through Dependabot or a deliberate maintenance change that refreshes the lockfile and passes all quality/security gates.

## Test design

- Test user-observable behavior and meaningful UI states.
- Reuse the project fixture so accessibility and visual policy is consistent.
- Prefer semantic locators (`getByRole`, `getByLabel`, etc.) over CSS when interacting with product UI.
- Use CSS selectors only where they represent an explicit testing contract, such as a visual mask marker or component scan boundary.
- Keep smoke tests cheap enough to run across all browser engines.
- Keep canonical visual assertions on the controlled Chromium projects unless a concrete cross-engine visual requirement justifies the cost.

## Accessibility changes

Do not solve an axe failure by disabling a rule globally. Fix the product when possible. If temporary suppression is necessary, use the exclusion object with a narrow selector, meaningful reason, durable issue reference, and expiry date.

Add keyboard/focus tests when interaction semantics change. A passing axe scan is not sufficient evidence for a new custom widget.

## Visual changes

Local snapshot updates are not committed:

```bash
npm run visual:update
npm run test:visual
```

On a PR, inspect the retained diff artifact. For an intentional change, an authorized maintainer may apply `visual-change-approved` after review. The workflow will preserve the original mismatch evidence and verify a candidate baseline. The merged `main` SHA then creates the new canonical artifact automatically.

Do not enlarge global screenshot tolerances to make a flaky test green. Stabilize inputs or use the narrowest justified dynamic mask.

## Pull requests

A pull request should state:

- behavior/quality contract changed;
- accessibility impact and manual checks performed;
- visual impact and whether a deliberate diff is expected;
- test evidence;
- linked issue/reference when applicable;
- any temporary accessibility exclusion and its expiry.

Keep workflow/action changes reviewable. GitHub Actions dependencies must remain pinned to immutable full commit SHAs.
