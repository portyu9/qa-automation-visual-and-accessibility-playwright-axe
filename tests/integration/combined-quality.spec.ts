import { test, expect } from '../fixtures/test.js';

test('interactive preview state satisfies accessibility and visual contracts together', async ({
  page,
  a11y,
  visual,
}) => {
  await page.goto('/components.html');
  await page.getByRole('tab', { name: 'Preview' }).click();

  await expect(page.getByRole('tabpanel', { name: 'Preview' })).toBeVisible();
  const results = await a11y.scan({ name: 'preview-tab-state', include: ['[data-tabs]'] });
  a11y.assertNoViolations(results);
  await visual.locatorScreenshot(page.locator('[data-tabs]'), 'preview-tab-state.png');
});
