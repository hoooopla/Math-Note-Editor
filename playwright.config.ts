import { defineConfig } from 'playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = process.env.PLAYWRIGHT_PORT || '3100';
const testWorkspace = mkdtempSync(path.join(tmpdir(), 'math-note-browser-tests-'));
process.once('exit', () => rmSync(testWorkspace, { recursive: true, force: true }));

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
            MATH_NOTE_WORKSPACE: testWorkspace,
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
