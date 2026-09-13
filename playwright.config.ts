import { defineConfig } from 'playwright/test';

const port = process.env.PLAYWRIGHT_PORT || '3100';

export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    outputDir: '.playwright-results',
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        serviceWorkers: 'block',
        trace: 'retain-on-failure'
    },
    webServer: {
        command: `npm run dev:test -- --port ${port}`,
        env: { DISABLE_HMR: 'true' },
        url: `http://127.0.0.1:${port}/api/runtime`,
        reuseExistingServer: false,
        timeout: 120_000
    }
});
