import { expect, type Locator, type Page } from '@playwright/test';

const DYNAMIC_CONTENT = '[data-visual-dynamic]';

export class VisualAssertions {
  public constructor(private readonly page: Page) {}

  private async settle(): Promise<void> {
    await this.page.evaluate(async () => {
      await document.fonts.ready;
    });
  }

  private async defaultMask(): Promise<Locator[]> {
    const dynamic = this.page.locator(DYNAMIC_CONTENT);
    return (await dynamic.count()) > 0 ? [dynamic] : [];
  }

  public async pageScreenshot(name: string, options: { fullPage?: boolean } = {}): Promise<void> {
    await this.settle();
    await expect(this.page).toHaveScreenshot(name, {
      fullPage: options.fullPage ?? true,
      animations: 'disabled',
      caret: 'hide',
      mask: await this.defaultMask(),
    });
  }

  public async locatorScreenshot(locator: Locator, name: string): Promise<void> {
    await this.settle();
    await expect(locator).toHaveScreenshot(name, {
      animations: 'disabled',
      caret: 'hide',
    });
  }
}
