import { test, expect } from '../fixtures/test.js';

test.describe('component accessibility states', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/components.html');
  });

  test('passes automated checks in the default state', async ({ a11y }) => {
    const results = await a11y.scan({ name: 'components-default' });
    a11y.assertNoViolations(results);
  });

  test('keeps tabs operable with arrow keys and synchronized state', async ({ page }) => {
    const stable = page.getByRole('tab', { name: 'Stable' });
    const preview = page.getByRole('tab', { name: 'Preview' });

    await stable.focus();
    await page.keyboard.press('ArrowRight');

    await expect(preview).toBeFocused();
    await expect(preview).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Preview' })).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Stable' })).toBeHidden();
  });

  test('passes automated checks while the modal dialog is open', async ({ page, a11y }) => {
    await page.getByRole('button', { name: 'Open confirmation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Promote this baseline?' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();

    const results = await a11y.scan({ name: 'confirmation-dialog', include: ['dialog'] });
    a11y.assertNoViolations(results);
  });

  test('moves focus to the first invalid field and announces validation status', async ({ page }) => {
    await page.getByRole('button', { name: 'Validate request' }).click();

    const title = page.getByRole('textbox', { name: 'Request title' });
    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('status')).toHaveText(
      'Request title must contain at least three characters.',
    );
  });
});
