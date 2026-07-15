import { defineConfig, devices, type Project } from '@playwright/test'

const chromium = {
  browserName: 'chromium' as const,
  channel: 'chrome' as const,
  colorScheme: 'dark' as const,
  viewport: { width: 1280, height: 800 },
}

const reportOutput = process.env.STRIKEFALL_QA_REPORT ?? './e2e/qa/report'

const projects: Project[] = [
  {
    name: 'chromium-resilience',
    testMatch: /(resilience|offline-install)\.spec\.ts/,
    use: {
      ...chromium,
      reducedMotion: 'reduce',
    },
  },
  {
    name: 'chromium-soak',
    testMatch: /soak\.spec\.ts/,
    use: {
      ...chromium,
      // Tracing every animation frame would perturb the memory signal this
      // project is measuring and produce multi-gigabyte failure artifacts.
      trace: 'off',
    },
  },
  {
    name: 'chromium-performance',
    testMatch: /performance\.spec\.ts/,
    use: {
      ...chromium,
      hasTouch: true,
      isMobile: true,
      reducedMotion: 'reduce',
      viewport: { width: 390, height: 844 },
      // Tracing and video materially perturb short interaction timings.
      trace: 'off',
      video: 'off',
    },
  },
]

// Playwright's WebKit is a useful Safari-compatibility signal, but it is kept
// opt-in so a missing browser binary can never turn the core Chromium QA lane
// red. Install it explicitly, then set STRIKEFALL_QA_WEBKIT=1.
if (process.env.STRIKEFALL_QA_WEBKIT === '1') {
  projects.push({
    name: 'webkit-resilience',
    testMatch: /resilience\.spec\.ts/,
    use: {
      ...devices['Desktop Safari'],
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    },
  })
}

export default defineConfig({
  testDir: './e2e/qa',
  outputDir: './e2e/qa/test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 7_500,
  },
  reporter: [
    ['line'],
    ['html', { outputFolder: reportOutput, open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects,
  webServer: {
    // A production preview avoids Vite HMR navigations while another agent is
    // editing source during a long-running soak.
    command: 'VITE_ROUND_API_URL=/api npm run build && npm run preview -- --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
