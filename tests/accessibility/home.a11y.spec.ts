import { test, expect } from '../fixtures/test.js';

test.describe('overview accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('has no automatically detectable WCAG A/AA violations', async ({ a11y }) => {
    const results = await a11y.scan({ name: 'overview-page' });
    a11y.assertNoViolations(results);
  });

  test('exposes semantic landmarks and accessible navigation names', async ({ page }) => {
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quality Console home' })).toHaveAccessibleName(
      'Quality Console home',
    );
  });

  test('supports keyboard skip navigation', async ({ page }) => {
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });
});
