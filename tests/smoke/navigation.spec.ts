import { test, expect } from '../fixtures/test.js';

test('primary navigation connects deterministic test surfaces', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');
  await expect(page).toHaveTitle('Quality Console');
  await page.getByRole('link', { name: 'Components', exact: true }).click();
  await expect(page).toHaveTitle('Component Laboratory | Quality Console');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Stateful UI quality checks');
  expect(consoleErrors).toEqual([]);
});
