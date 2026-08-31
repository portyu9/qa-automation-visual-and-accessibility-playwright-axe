## Summary

Describe the behavior or quality contract changed.

## Validation

- [ ] `npm run check`
- [ ] Relevant Playwright suites pass
- [ ] Accessibility impact reviewed
- [ ] Keyboard/focus behavior checked when interaction semantics changed
- [ ] Visual diff reviewed when pixels changed
- [ ] No unexplained console/runtime errors introduced

## Accessibility

Describe affected states, manual checks, and any axe findings. If an exclusion is added, link the remediation issue and state its expiry date.

## Visual regression

- [ ] No visual change expected
- [ ] Intentional visual change; diff evidence reviewed

Do not apply `visual-change-approved` merely to clear a failing check. An authorized maintainer should apply it only after confirming the pixel change is intended.

## Security / supply chain

Call out dependency, workflow permission, external action, or target-environment changes.
