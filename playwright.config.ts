import { defineConfig, devices } from '@playwright/test';
import { runtimeConfig } from './framework/config.js';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: runtimeConfig.ci,
  retries: runtimeConfig.ci ? 1 : 0,
  workers: runtimeConfig.ci ? 2 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      threshold: 0.15,
      maxDiffPixelRatio: 0.0005,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  reporter: runtimeConfig.ci
    ? [
        ['line'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/junit.xml' }],
      ]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: runtimeConfig.baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testMatch: '**/smoke/**/*.spec.ts',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: '**/smoke/**/*.spec.ts',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: ['**/visual/**/*.spec.ts', '**/integration/**/*.spec.ts'],
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'node scripts/test-site-server.mjs',
        url: `${runtimeConfig.baseURL}/healthz`,
        reuseExistingServer: !runtimeConfig.ci,
        timeout: 15_000,
      },
});
