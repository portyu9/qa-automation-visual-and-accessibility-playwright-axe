import { test, expect } from '../fixtures/test.js';

test('audit harness detects deterministic known violations', async ({ page, a11y }) => {
  await page.goto('/fixtures/known-violations.html');
  const results = await a11y.scan({ name: 'known-violations-contract' });
  const ruleIds = results.violations.map((violation) => violation.id);

  expect(ruleIds).toContain('button-name');
  expect(ruleIds).toContain('image-alt');
  expect(() => a11y.assertNoViolations(results)).toThrow(/button-name/);
});
