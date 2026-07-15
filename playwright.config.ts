import { defineConfig } from '@playwright/test'

const rankedComposeRun = process.env.STRIKEFALL_E2E_RANKED === '1'
const existingDevServer = process.env.STRIKEFALL_EXISTING_DEV_SERVER
const browserBaseUrl = rankedComposeRun
  ? 'http://127.0.0.1:4173'
  : existingDevServer ?? 'http://127.0.0.1:4174'

const chrome = {
  channel: 'chrome' as const,
  colorScheme: 'dark' as const,
  reducedMotion: 'reduce' as const,
}

const localTestIgnore = /(?:[/\\]qa[/\\]|ranked-mobile-performance\.spec\.ts)/

export default defineConfig({
  testDir: './e2e',
  testIgnore: /[/\\]qa[/\\]/,
  outputDir: './e2e/test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [
    ['line'],
    ['html', { outputFolder: './e2e/report', open: 'never' }],
  ],
  use: {
    baseURL: browserBaseUrl,
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-1280',
      testIgnore: localTestIgnore,
      use: {
        ...chrome,
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'tablet-768',
      testIgnore: localTestIgnore,
      use: {
        ...chrome,
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: 'mobile-375',
      testIgnore: localTestIgnore,
      use: {
        ...chrome,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 375, height: 812 },
      },
    },
    ...(rankedComposeRun ? [{
      name: 'ranked-mobile-network',
      testMatch: /ranked-mobile-performance\.spec\.ts/,
      use: {
        ...chrome,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
        // Recording perturbs a sub-two-second interaction measurement. The
        // JSON metrics attachment and failure screenshot remain available.
        trace: 'off' as const,
        video: 'off' as const,
      },
    }] : []),
  ],
  // Ranked E2E runs against the complete Compose edge, which owns :4173 and
  // serves both frontend and API. Local responsive runs normally own an
  // isolated Vite process so a passing test cannot come from an unrelated
  // stale server. STRIKEFALL_EXISTING_DEV_SERVER is an explicit opt-in for
  // focused checks against a caller-owned process.
  webServer: rankedComposeRun || existingDevServer ? undefined : {
    command: 'npm run dev -- --port 4174 --strictPort',
    url: browserBaseUrl,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
