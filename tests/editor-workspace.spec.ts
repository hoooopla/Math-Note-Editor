import { expect, test } from 'playwright/test';
import { readFileSync } from 'node:fs';
import { openEditor, replaceEditorText } from './helpers/editor';

const appVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset');
    expect(response.ok()).toBeTruthy();
});

test('loads the graph feature only when it is opened', async ({ page }) => {
    await openEditor(page);
    await expect(page.getByRole('heading', { name: 'Graph View' })).toBeHidden();
    await page.getByLabel('Open graph view').click();
    await expect(page.getByRole('heading', { name: 'Graph View' })).toBeVisible();
});

test('opens the separate blocks view and filters workspace health without replacing graph view', async ({ page, request }) => {
    const root = await (await request.post('/api/blocks', {
        data: { title: 'Map root', label: 'map-demo', content: 'Root content.' }
    })).json();
    const emptyChild = await (await request.post('/api/blocks', {
        data: { title: 'Empty child', label: 'map-demo/empty', content: '' }
    })).json();
    const brokenSource = await (await request.post('/api/blocks', {
        data: { title: 'Broken source', label: 'map-demo/source', content: 'See [[map-demo]] and [[map-demo/missing]].' }
    })).json();
    const orphan = await (await request.post('/api/blocks', {
        data: { title: 'Detached orphan', label: 'detached-orphan', content: 'No relationships.' }
    })).json();

    await openEditor(page);
    await expect(page.getByLabel('Open graph view')).toBeVisible();
    await page.getByLabel('Open blocks view').click();
    await expect(page.getByRole('heading', { name: 'Blocks View' })).toBeVisible();
    await expect(page.getByTestId(`block-map-node-${root.id}`)).toBeVisible();
    await page.getByLabel('Expand map-demo', { exact: true }).click();
    await expect(page.getByTestId(`block-map-node-${emptyChild.id}`)).toBeVisible();
    await expect(page.getByTestId(`block-map-node-${brokenSource.id}`)).toBeVisible();
    await page.getByTestId(`block-map-node-${brokenSource.id}`).click();
    await expect(page.getByTestId('block-map-missing-target').filter({ hasText: 'map-demo/missing' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Block inspector' })).toBeVisible();

    await page.locator('.bv-filter-menu summary').click();
    await page.getByLabel('Filter by state').selectOption('broken');
    await expect(page.getByTestId(`block-map-node-${brokenSource.id}`)).toBeVisible();
    await expect(page.getByTestId(`block-map-node-${root.id}`)).toBeVisible();
    await expect(page.getByTestId(`block-map-node-${emptyChild.id}`)).toHaveCount(0);

    await page.getByLabel('Filter by state').selectOption('all');
    await page.getByLabel('Search blocks view').fill('Detached orphan');
    await expect(page.getByTestId(`block-map-node-${orphan.id}`)).toBeVisible();
    await expect(page.getByRole('status')).toContainText('1 of');
    await page.getByTestId(`block-map-node-${orphan.id}`).click();
    await expect(page.getByLabel('Relationship map').locator('.bv-graph-selected')).toContainText('Detached orphan');

    await page.getByLabel('Close blocks view').click();
    await expect(page.getByRole('heading', { name: 'Blocks View' })).toBeHidden();
    await page.getByLabel('Open graph view').click();
    await expect(page.getByRole('heading', { name: 'Graph View' })).toBeVisible();
});

test('flushes the latest editor content when focus leaves the block', async ({ page }) => {
    const editor = await openEditor(page);
    const content = `Persistence flush ${Date.now()} with $\\frac{a}{b}$`;

    const saveRequest = page.waitForRequest(request =>
        request.method() === 'PUT' && request.url().includes('/api/blocks/')
    );
    await replaceEditorText(page, editor, content);
    await page.getByLabel('Open settings').click();
    const request = await saveRequest;
    expect(request.postDataJSON().content).toBe(content);
    const blockId = request.url().split('/').at(-1)!;

    await expect.poll(async () => {
        const saved = await page.request.get(`/api/blocks/${blockId}`);
        return (await saved.json()).content;
    }).toBe(content);
});

test('serializes overlapping saves without restoring stale content', async ({ page }) => {
    const editor = await openEditor(page);
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>(resolve => { releaseFirstSave = resolve; });
    let markFirstRequestSeen!: (request: import('playwright/test').Request) => void;
    const firstRequestSeen = new Promise<import('playwright/test').Request>(resolve => { markFirstRequestSeen = resolve; });
    let isFirstSave = true;
    await page.route('**/*', async route => {
        if (route.request().method() === 'PUT' && route.request().url().includes('/api/blocks/') && isFirstSave) {
            isFirstSave = false;
            markFirstRequestSeen(route.request());
            await firstSaveGate;
        }
        await route.continue();
    });

    await replaceEditorText(page, editor, 'First save');
    await editor.evaluate(element => (element as HTMLElement).blur());
    await firstRequestSeen;
    await editor.focus();

    await page.keyboard.press('End');
    await page.keyboard.type(' plus latest input');
    const latestRequest = page.waitForRequest(request =>
        request.method() === 'PUT'
        && request.url().includes('/api/blocks/')
        && request.postDataJSON().content === 'First save plus latest input'
    );
    await editor.evaluate(element => (element as HTMLElement).blur());
    releaseFirstSave();
    expect((await latestRequest).postDataJSON().content).toBe('First save plus latest input');
    await editor.click();
    await expect(editor).toContainText('First save plus latest input');
});

test('reports a failed save and retries the latest content after another edit', async ({ page }) => {
    const editor = await openEditor(page);
    let failNextSave = true;
    let markFailedRequestSeen!: () => void;
    const failedRequestSeen = new Promise<void>(resolve => { markFailedRequestSeen = resolve; });
    await page.route('**/*', async route => {
        if (route.request().method() === 'PUT' && route.request().url().includes('/api/blocks/') && failNextSave) {
            failNextSave = false;
            markFailedRequestSeen();
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'test failure' }) });
            return;
        }
        await route.continue();
    });

    await replaceEditorText(page, editor, 'Save failure recovery');
    await editor.evaluate(element => (element as HTMLElement).blur());
    await failedRequestSeen;
    await expect(page.getByText(/Changes may not have been saved:.*test failure/)).toBeVisible();

    const retryRequest = page.waitForRequest(request =>
        request.method() === 'PUT' && request.url().includes('/api/blocks/')
    );
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' succeeded');
    await editor.evaluate(element => (element as HTMLElement).blur());
    expect((await retryRequest).postDataJSON().content).toBe('Save failure recovery succeeded');
    await expect(page.getByText(/Changes may not have been saved/)).toBeHidden();
});

test('saves a pasted note larger than the browser keepalive limit', async ({ page }) => {
    const editor = await openEditor(page);
    const content = `Large paste ${Date.now()}\n${'long mathematical note '.repeat(4000)}`;
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(64 * 1024);
    const saveRequest = page.waitForRequest(request =>
        request.method() === 'PUT' && request.url().includes('/api/blocks/') && request.postDataJSON().content === content
    );
    await replaceEditorText(page, editor, content);
    await editor.evaluate(element => (element as HTMLElement).blur());
    const request = await saveRequest;
    const blockId = request.url().split('/').at(-1)!;
    await expect.poll(async () => {
        const saved = await page.request.get(`/api/blocks/${blockId}`);
        return (await saved.json()).content;
    }).toBe(content);
    await expect(page.getByText(/Changes may not have been saved/)).toBeHidden();
});

test('keeps concurrent small note saves below the combined keepalive limit', async ({ page }) => {
    await openEditor(page);
    const keepaliveFlags = await page.evaluate(async () => {
        const originalFetch = window.fetch;
        const flags: boolean[] = [];
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).startsWith('/api/blocks/')) {
                flags.push(Boolean(init?.keepalive));
                return new Promise<Response>(resolve => setTimeout(() => resolve(new Response(JSON.stringify({ block: {} }), {
                    status: 200, headers: { 'Content-Type': 'application/json' }
                })), 100));
            }
            return originalFetch(input, init);
        }) as typeof fetch;
        try {
            const { api } = await (new Function('return import("/src/store/api.ts")'))();
            const content = 'x'.repeat(40 * 1024);
            await Promise.all([
                api.updateBlock('first', { id: 'first', title: 'First', label: 'first', content }),
                api.updateBlock('second', { id: 'second', title: 'Second', label: 'second', content })
            ]);
            return flags;
        } finally {
            window.fetch = originalFetch;
        }
    });
    expect(keepaliveFlags).toEqual([true, false]);
});

test('Reconnect preserves an unsaved paste until its failed save can be retried', async ({ page }) => {
    const editor = await openEditor(page);
    const content = `Unsent paste ${Date.now()}\n${'proof '.repeat(100)}`;
    let failSaves = true;
    await page.route('**/api/blocks/*', async route => {
        if (failSaves && route.request().method() === 'PUT') return route.abort('failed');
        await route.continue();
    });

    await replaceEditorText(page, editor, content);
    await editor.evaluate(element => (element as HTMLElement).blur());
    await expect(page.getByText(/Changes may not have been saved: Failed to fetch/)).toBeVisible();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByText(/Could not reconnect without losing unsaved changes/)).toBeVisible();
    await expect(editor).toContainText(content.split('\n')[0]);

    failSaves = false;
    const retry = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/blocks/'));
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    const blockId = (await retry).url().split('/').at(-1)!;
    await expect.poll(async () => {
        const saved = await page.request.get(`/api/blocks/${blockId}`);
        return (await saved.json()).content;
    }).toBe(content);
    await expect(page.getByText(/Changes may not have been saved/)).toBeHidden();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toContainText(content.split('\n')[0]);
});

test('shows the running build identity in General Settings', async ({ page }) => {
    await openEditor(page);
    await page.getByLabel('Open settings').click();
    const build = page.getByTestId('build-info');
    await expect(build).toContainText(`Version ${appVersion}`);
    await expect(build).toContainText('Development server');
    await expect(page.locator('h1').getByLabel(`Version ${appVersion}`)).toHaveCount(0);
});

test('keeps the desktop app name without a version suffix', async ({ page }) => {
    await page.route('**/api/runtime', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), desktop: true } });
    });
    await openEditor(page);
    await expect(page.locator('h1')).toContainText('Math Note Editor');
    await expect(page.locator('h1')).not.toContainText(appVersion);
    await expect(page.locator('h1').getByLabel(`Version ${appVersion}`)).toHaveCount(0);
});

test('validates settings and supports keyboard dialog navigation', async ({ page }) => {
    await openEditor(page);
    const settingsButton = page.getByLabel('Open settings');
    await settingsButton.focus();
    await settingsButton.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Editor Settings' });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Close settings')).toBeFocused();

    const keyboardTab = page.getByRole('tab', { name: 'Keyboard Shortcuts' });
    await keyboardTab.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: 'Math Macros' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'General Setting' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Current workspace')).toContainText('Local server · blocks');
    await keyboardTab.click();

    await page.getByLabel('Global Search Shortcut').fill('k');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('alert')).toContainText('Search shortcut must be F1–F12 or contain');
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Close current note tab shortcut')).toHaveValue('mod+w');
    await expect(page.getByLabel('Edit active block metadata shortcut')).toHaveValue('f2');
    await expect(page.getByLabel('Reopen closed note tab shortcut')).toHaveValue('mod+shift+t');
    await expect(page.getByText('Restores the most recently closed tab, including its former position and editor focus.')).toBeVisible();
    await expect(page.getByLabel('Math Block Vertical Padding (px)')).toHaveCount(0);

    await page.getByLabel('Global Search Shortcut').fill('meta+k');
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByLabel('Math Block Vertical Padding (px)').fill('-1');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('alert')).toContainText('Math block vertical padding must be between 0 and 100');

    await page.getByLabel('Math Block Vertical Padding (px)').fill('4');
    await page.getByRole('tab', { name: 'Math Macros' }).click();
    await page.getByRole('button', { name: 'Add Macro' }).click();
    await page.getByLabel(/Macro \d+ name/).last().fill('1bad');
    await page.getByLabel(/Macro \d+ replacement/).last().fill('x');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('alert')).toContainText('must be a backslash followed by letters');

    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByLabel('Default Text hex color').fill('red');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('alert')).toContainText('must be a six-digit hex color');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settingsButton).toBeFocused();
});

test('shows and reveals the current desktop workspace from settings', async ({ page }) => {
    await page.addInitScript(() => {
        let revealCount = 0;
        window.mathNotesDesktop = {
            updateShortcuts() {},
            chooseWorkspace: async () => false,
            getWorkspacePath: async () => '/Users/test/Math Notes Workspace',
            showWorkspaceInFolder: async () => { revealCount += 1; return true; },
            onCommand() { return () => {}; },
            onPrepareWorkspaceChange() { return () => {}; }
        };
        (window as any).__workspaceRevealCount = () => revealCount;
    });

    await openEditor(page);
    await page.getByLabel('Open settings').click();
    await expect(page.getByLabel('Current workspace path')).toHaveText('/Users/test/Math Notes Workspace');
    await page.getByRole('button', { name: 'Show in Finder' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__workspaceRevealCount())).toBe(1);
});

test('shows workspace backups and restores only after confirmation', async ({ page }) => {
    let restoreCount = 0;
    await page.route('**/api/backups', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ path: 'Algebra.md', modifiedAt: Date.now(), size: 240 }])
    }));
    await page.route('**/api/backups/restore', async route => {
        restoreCount += 1;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });
    await openEditor(page);
    await page.getByLabel('Open settings').click();
    await expect(page.getByLabel('Available backups')).toContainText('Algebra.md');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    expect(restoreCount).toBe(0);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => restoreCount).toBe(1);
    await expect(page.getByRole('status')).toContainText('previous current version is now the backup');
});

test('restores open tabs and the active tab from workspace settings', async ({ page, request }) => {
    const blocks = await (await request.get('/api/blocks?metaOnly=true')).json();
    const ids = blocks.slice(0, 2).map((block: { id: string }) => block.id);
    expect(ids).toHaveLength(2);
    const saved = await request.post('/api/workspace/session', { data: {
        openTabs: ids, activeTab: ids[1], lockedTabs: [ids[0]], persistForTest: true
    } });
    expect(saved.ok()).toBeTruthy();

    await openEditor(page);
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-controls', `block-tab-panel-${ids[1]}`);
    await page.locator(`[role="tab"][aria-controls="block-tab-panel-${ids[0]}"]`).click();
    await expect(page.locator(`[role="tabpanel"]#block-tab-panel-${ids[0]} .cm-content`).first()).toHaveAttribute('contenteditable', 'false');
});
