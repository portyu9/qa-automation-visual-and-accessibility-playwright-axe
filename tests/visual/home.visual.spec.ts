import { test } from '../fixtures/test.js';

test('overview page matches the governed visual baseline', async ({ page, visual }) => {
  await page.goto('/');
  await visual.pageScreenshot('overview-page.png');
});

test('quality-signal card matches its component baseline', async ({ page, visual }) => {
  await page.goto('/');
  await visual.locatorScreenshot(page.getByRole('complementary'), 'quality-signal-card.png');
});
