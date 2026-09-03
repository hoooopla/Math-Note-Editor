import { expect, test, type Locator, type Page } from 'playwright/test';

async function openEditor(page: Page) {
    const runtime = await page.request.get('/api/runtime');
    expect(runtime.ok()).toBeTruthy();
    expect(await runtime.json()).toEqual({ testMode: true });

    await page.goto('/');
    await expect(page.getByLabel('In-memory test mode')).toBeVisible();
    const editor = page.locator('.cm-content').first();
    await expect(editor).toBeVisible();
    return editor;
}

async function replaceEditorText(page: Page, editor: Locator, text: string) {
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(text);
}

test('renders inline math and continues Markdown markers with Enter', async ({ page }) => {
    const editor = await openEditor(page);

    await replaceEditorText(page, editor, 'Text with $x^2$ inline math');
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-inline .katex')).toBeVisible();
    await page.keyboard.press('Escape');

    for (const [source, expected] of [
        ['* first', '* first\n* second\n'],
        ['1. first', '1. first\n2. second\n'],
        ['> first', '> first\n> second\n']
    ]) {
        const saveRequest = page.waitForRequest(request =>
            request.method() === 'PUT' && request.url().includes('/api/blocks/')
        );
        await replaceEditorText(page, editor, source);
        await page.keyboard.press('Enter');
        await page.keyboard.insertText('second');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.getByLabel('Open settings').click();
        expect((await saveRequest).postDataJSON().content).toBe(expected);
        await page.keyboard.press('Escape');
    }
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
    let isFirstSave = true;
    await page.route('**/api/blocks/*', async route => {
        if (route.request().method() === 'PUT' && isFirstSave) {
            isFirstSave = false;
            await firstSaveGate;
        }
        await route.continue();
    });

    const firstRequest = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/blocks/'));
    await replaceEditorText(page, editor, 'First save');
    await firstRequest;

    await page.keyboard.press('End');
    await page.keyboard.insertText(' plus latest input');
    const latestRequest = page.waitForRequest(request =>
        request.method() === 'PUT'
        && request.url().includes('/api/blocks/')
        && request.postDataJSON().content === 'First save plus latest input'
    );
    await page.getByLabel('Open settings').click();
    releaseFirstSave();
    expect((await latestRequest).postDataJSON().content).toBe('First save plus latest input');
    await page.keyboard.press('Escape');
    await editor.click();
    await expect(editor).toContainText('First save plus latest input');
});

test('reports a failed save and retries the latest content after another edit', async ({ page }) => {
    const editor = await openEditor(page);
    let failNextSave = true;
    await page.route('**/api/blocks/*', async route => {
        if (route.request().method() === 'PUT' && failNextSave) {
            failNextSave = false;
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'test failure' }) });
            return;
        }
        await route.continue();
    });

    await replaceEditorText(page, editor, 'Save failure recovery');
    await page.getByLabel('Open settings').click();
    await expect(page.getByText(/Changes may not have been saved:.*test failure/)).toBeVisible();
    await page.keyboard.press('Escape');

    const retryRequest = page.waitForRequest(request =>
        request.method() === 'PUT' && request.url().includes('/api/blocks/')
    );
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' succeeded');
    await page.getByLabel('Open settings').click();
    expect((await retryRequest).postDataJSON().content).toBe('Save failure recovery succeeded');
    await expect(page.getByText(/Changes may not have been saved/)).toBeHidden();
});

test('validates settings and supports keyboard dialog navigation', async ({ page }) => {
    await openEditor(page);
    const settingsButton = page.getByLabel('Open settings');
    await settingsButton.focus();
    await settingsButton.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Editor Settings' });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Close settings')).toBeFocused();

    const generalTab = page.getByRole('tab', { name: 'Keyboard Shortcuts' });
    await generalTab.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: 'Math Macros' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(generalTab).toHaveAttribute('aria-selected', 'true');

    await page.getByLabel('Global Search Shortcut').fill('k');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('alert')).toContainText('Search shortcut must contain');
    await expect(dialog).toBeVisible();

    await page.getByLabel('Global Search Shortcut').fill('meta+k');
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

    await page.getByRole('tab', { name: 'LaTeX Highlight Colors' }).click();
    await page.getByLabel('Default Text hex color').fill('red');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('alert')).toContainText('must be a six-digit hex color');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(settingsButton).toBeFocused();
});
