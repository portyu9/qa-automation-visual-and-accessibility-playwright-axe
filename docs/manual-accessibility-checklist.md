# Manual accessibility checklist

Use this checklist for human validation of high-value journeys and before significant releases. Record the browser, assistive technology, operating system, viewport/zoom setting, build SHA, tester, and disposition of any finding.

## Keyboard-only

- Reach all interactive controls without a pointing device.
- Confirm focus order follows the task and visual reading order.
- Confirm every focused control has a clearly visible focus indicator.
- Verify skip navigation lands on the intended primary content.
- Verify custom composite widgets implement the documented keyboard pattern.
- Verify dialogs place focus sensibly, prevent accidental interaction behind the modal where required, support expected dismissal, and return focus appropriately.
- Verify no keyboard traps exist.

## Screen reader

- Confirm page title, language, headings, regions, and landmarks communicate useful structure.
- Confirm controls have concise, accurate names and state/value announcements.
- Confirm dynamic status/error messages are announced at the right time without excessive interruption.
- Confirm form labels, instructions, required state, errors, and corrections are understandable in context.
- Confirm meaningful images have useful alternatives and decorative images are ignored.
- Confirm table/list relationships are understandable when visual layout is unavailable.

Test with combinations appropriate to the product's support policy rather than assuming one screen reader/browser pair is representative.

## Zoom, reflow, and text spacing

- Validate browser zoom at 200% and reflow behavior at 400% where applicable.
- Confirm essential content is not clipped, overlapped, or hidden and horizontal scrolling is not introduced unnecessarily.
- Apply WCAG text-spacing overrides and confirm content remains usable.
- Confirm responsive controls preserve accessible names and target usability when compacted.

## Visual perception

- Confirm information is not communicated by color alone.
- Review contrast in meaningful states, including focus, hover, disabled, selected, and error states.
- Confirm text rendered over images/gradients remains readable in realistic content states.
- Confirm focus indicators are visible against adjacent colors, not just technically present.

## Motion, timing, and interruption

- Verify reduced-motion preferences remove or simplify nonessential motion.
- Confirm moving/flashing content stays within safety requirements.
- Confirm time limits can be extended or disabled when required.
- Confirm notifications, auto-updates, and focus changes do not unexpectedly interrupt the user.

## Content and cognition

- Confirm headings, labels, instructions, and errors are specific and consistent.
- Confirm destructive/irreversible actions are identified before commitment.
- Confirm error recovery explains what happened and how to fix it.
- Confirm repeated navigation and controls use consistent naming and placement.
- Confirm authentication flows do not depend unnecessarily on memory, puzzles, or inaccessible verification methods.

## Disposition

For each finding, record:

- affected journey/state;
- expected behavior;
- observed behavior;
- impact on users;
- WCAG criterion when known;
- severity/priority;
- durable issue reference;
- retest evidence after remediation.
