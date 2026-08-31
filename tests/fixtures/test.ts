import { test as base, expect } from '@playwright/test';
import { AccessibilityAuditor } from '../../framework/accessibility/auditor.js';
import { VisualAssertions } from '../../framework/visual/assertions.js';

interface QualityFixtures {
  a11y: AccessibilityAuditor;
  visual: VisualAssertions;
}

export const test = base.extend<QualityFixtures>({
  a11y: async ({ page }, use, testInfo) => {
    await use(new AccessibilityAuditor(page, testInfo));
  },
  visual: async ({ page }, use) => {
    await use(new VisualAssertions(page));
  },
});

export { expect };
