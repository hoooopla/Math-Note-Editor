import { defineConfig } from 'playwright/test';

export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    outputDir: '/tmp/math-note-playwright-results',
    use: {
        baseURL: 'http://127.0.0.1:3100',
        channel: 'chrome',
        trace: 'retain-on-failure'
    },
    webServer: {
        command: 'npm run dev:test -- --port 3100',
        env: { DISABLE_HMR: 'true' },
        url: 'http://127.0.0.1:3100/api/runtime',
        reuseExistingServer: false,
        timeout: 120_000
    }
});
