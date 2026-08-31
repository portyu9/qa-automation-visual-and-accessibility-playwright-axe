import { test, expect } from '../fixtures/test.js';
import { validateExclusions } from '../../framework/accessibility/policy.js';

test.describe('accessibility exclusion policy', () => {
  test('accepts a reviewed future-dated exclusion', () => {
    expect(() =>
      validateExclusions(
        [
          {
            selector: '[data-third-party-widget]',
            reason: 'Vendor remediation is tracked and scheduled.',
            issue: 'A11Y-241',
            expires: '2026-10-31',
          },
        ],
        new Date('2026-08-31T12:00:00Z'),
      ),
    ).not.toThrow();
  });

  test('fails closed when an exclusion expires', () => {
    expect(() =>
      validateExclusions(
        [
          {
            selector: '[data-third-party-widget]',
            reason: 'Vendor remediation is tracked and scheduled.',
            issue: 'A11Y-241',
            expires: '2026-08-30',
          },
        ],
        new Date('2026-08-31T12:00:00Z'),
      ),
    ).toThrow(/expired on 2026-08-30/);
  });

  test('rejects invalid calendar dates instead of normalizing them', () => {
    expect(() =>
      validateExclusions(
        [
          {
            selector: '[data-third-party-widget]',
            reason: 'Vendor remediation is tracked and scheduled.',
            issue: 'A11Y-241',
            expires: '2026-02-31',
          },
        ],
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toThrow(/valid ISO expiry date/);
  });
});
