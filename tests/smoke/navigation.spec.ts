import { test, expect } from '../fixtures/test.js';

test('primary navigation connects deterministic test surfaces', async ({ page }) => {
  const consoleErrors: string[] = [];
  // Collect browser-native CSP violation detail before either document loads.
  // This is diagnostic only: the zero-console-errors assertion remains strict.
  await page.addInitScript(() => {
    const reports: Array<Record<string, string | number>> = [];
    Object.defineProperty(window, '__strictCspViolationReports', {
      value: reports,
      writable: false,
      configurable: false,
    });
    document.addEventListener('securitypolicyviolation', (event) => {
      reports.push({
        effectiveDirective: event.effectiveDirective,
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        columnNumber: event.columnNumber,
        sample: event.sample,
        inlineStyleTags: document.querySelectorAll('style').length,
        inlineStyleAttributes: document.querySelectorAll('[style]').length,
      });
    });
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url, lineNumber, columnNumber } = message.location();
    const origin = url ? ` (${url}:${lineNumber}:${columnNumber})` : ' (browser-generated)';
    consoleErrors.push(`${message.text()}${origin}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');
  await expect(page).toHaveTitle('Quality Console');
  await page.getByRole('link', { name: 'Components', exact: true }).click();
  await expect(page).toHaveTitle('Component Laboratory | Quality Console');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Stateful UI quality checks');
  const browserCspReports = await page.evaluate(() =>
    Reflect.get(window, '__strictCspViolationReports'),
  );
  expect(consoleErrors, `Browser CSP reports: ${JSON.stringify(browserCspReports)}`).toEqual([]);
});
