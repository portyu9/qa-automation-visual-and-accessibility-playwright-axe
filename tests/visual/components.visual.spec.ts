import { test } from '../fixtures/test.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/components.html');
});

test('component laboratory matches its default baseline', async ({ visual }) => {
  await visual.pageScreenshot('component-laboratory.png');
});

test('dialog open state matches its baseline', async ({ page, visual }) => {
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await visual.locatorScreenshot(
    page.getByRole('dialog', { name: 'Promote this baseline?' }),
    'confirmation-dialog.png',
  );
});

test('validation error state matches its baseline', async ({ page, visual }) => {
  await page.getByRole('button', { name: 'Validate request' }).click();
  await visual.locatorScreenshot(page.locator('[data-request-form]'), 'change-request-invalid.png');
});
