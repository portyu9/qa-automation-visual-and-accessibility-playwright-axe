import { test as base, expect } from '@playwright/test';
import { AccessibilityAuditor } from '../../framework/accessibility/auditor.js';
import { VisualAssertions } from '../../framework/visual/assertions.js';

interface QualityFixtures {
  qualityEnvironment: void;
  a11y: AccessibilityAuditor;
  visual: VisualAssertions;
}

export const test = base.extend<QualityFixtures>({
  qualityEnvironment: [
    async ({ page }, use) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await use();
    },
    { auto: true },
  ],
  a11y: async ({ page }, use, testInfo) => {
    await use(new AccessibilityAuditor(page, testInfo));
  },
  visual: async ({ page }, use) => {
    await use(new VisualAssertions(page));
  },
});

export { expect };
