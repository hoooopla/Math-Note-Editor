import { defineConfig } from 'playwright/test';

const port = process.env.PLAYWRIGHT_PORT || '3100';

export default defineConfig({
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    outputDir: '.playwright-results',
    use: {
        baseURL: `http://127.0.0.1:${port}`,
        serviceWorkers: 'block',
        trace: 'retain-on-failure'
    },
    webServer: {
        command: `npm run dev:test -- --port ${port}`,
        env: {
            DISABLE_HMR: 'true',
            VITE_ENABLE_GOOGLE_DRIVE: 'true',
            VITE_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
            VITE_GOOGLE_API_KEY: 'test-api-key',
            VITE_GOOGLE_APP_ID: '123456789'
        },
        url: `http://127.0.0.1:${port}/api/runtime`,
        reuseExistingServer: false,
        timeout: 120_000
    }
});
