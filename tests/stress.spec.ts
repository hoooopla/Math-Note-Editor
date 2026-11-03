import { expect, test, type Page } from 'playwright/test';

const scale = Math.min(4, Math.max(1, Number(process.env.STRESS_SCALE) || 1));
const plainContent = Array.from({ length: 1_600 * scale }, (_, i) =>
    `Line ${i}: We can refine this proof while keeping its definitions and references intact.\n`).join('');
const mathContent = Array.from({ length: 240 * scale }, (_, i) =>
    `Step ${i}: $\\frac{x_${i}+y_${i}}{1+z_${i}^2}\\leq\\sum_{k=1}^{n} a_k$ follows from the estimate.\n`).join('');

async function openScratchNote(page: Page, label: string) {
    const created = await page.request.post('/api/blocks', {
        data: { title: 'Generated stress note', label, content: '' }
    });
    expect(created.ok()).toBe(true);
    const { id } = await created.json() as { id: string };
    await page.goto('/');
    await expect(page.getByLabel('In-memory test mode')).toBeVisible();
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(label);
    await search.press('Enter');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    return { id, editor };
}

for (const [kind, content] of [['plain', plainContent], ['math', mathContent]] as const) {
    test(`@stress large ${kind} note survives paste, typing, bulk deletion and save`, async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
        const pageErrors: string[] = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('crash', () => pageErrors.push('Renderer crashed'));
        expect((await (await page.request.get('/api/runtime')).json()).testMode).toBe(true);
        const { id, editor } = await openScratchNote(page, `test:stress-${kind}-${Date.now()}`);
        const metrics: Record<string, number> = { bytes: new TextEncoder().encode(content).byteLength };
        const savedEquals = async (expected: string) => {
            const response = await page.request.get(`/api/blocks/${id}`);
            if (!response.ok()) return false;
            return (await response.json() as { content: string }).content === expected;
        };
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: new URL(page.url()).origin
        });
        await page.evaluate(text => navigator.clipboard.writeText(text), content);
        await editor.focus();
        const pasteStart = Date.now();
        await page.keyboard.press('ControlOrMeta+V');
        await editor.blur();
        await expect.poll(() => savedEquals(content), { timeout: 45_000 }).toBe(true);
        metrics.pasteAndSaveMs = Date.now() - pasteStart;

        await editor.focus();
        await page.keyboard.press('ControlOrMeta+End');
        const typed = '\nA short new thought: $x+y=z$.';
        const typingStart = Date.now();
        await page.keyboard.type(typed);
        await editor.blur();
        await expect.poll(() => savedEquals(content + typed), { timeout: 45_000 }).toBe(true);
        metrics.typeAndSaveMs = Date.now() - typingStart;

        const deletionStart = Date.now();
        await editor.focus();
        await page.keyboard.press('ControlOrMeta+A');
        const selected = await editor.evaluate(async element => {
            const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
            const { EditorView } = await import(viewUrl);
            const view = EditorView.findFromDOM(element.closest('.cm-editor')!);
            return { from: view.state.selection.main.from, to: view.state.selection.main.to, length: view.state.doc.length };
        });
        expect(selected).toEqual({ from: 0, to: content.length + typed.length, length: content.length + typed.length });
        await page.keyboard.press('Backspace');
        const afterDeleteLength = await editor.evaluate(async element => {
            const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
            const { EditorView } = await import(viewUrl);
            return EditorView.findFromDOM(element.closest('.cm-editor')!).state.doc.length;
        });
        expect(afterDeleteLength).toBe(0);
        await editor.blur();
        await expect.poll(() => savedEquals(''), { timeout: 10_000 }).toBe(true).catch(async () => {
            const saved = await (await page.request.get(`/api/blocks/${id}`)).json() as { content: string };
            throw new Error(`Bulk deletion left ${saved.content.length} characters in the ${kind} note.`);
        });
        metrics.deleteAndSaveMs = Date.now() - deletionStart;

        await editor.focus();
        await page.keyboard.press('ControlOrMeta+Z');
        await expect.poll(() => savedEquals(content + typed), { timeout: 45_000 }).toBe(true);
        await page.keyboard.press('ControlOrMeta+Shift+Z');
        await expect.poll(() => savedEquals(''), { timeout: 45_000 }).toBe(true);

        await editor.focus();
        await page.keyboard.type('Editing continues after deletion.');
        await expect(editor).toHaveText('Editing continues after deletion.');
        await editor.blur();
        await expect.poll(() => savedEquals('Editing continues after deletion.'), { timeout: 45_000 }).toBe(true);

        expect(pageErrors).toEqual([]);
        await testInfo.attach('stress-metrics', {
            body: JSON.stringify({ kind, ...metrics }, null, 2), contentType: 'application/json'
        });
        console.log(`Stress ${kind}: ${JSON.stringify(metrics)}`);
    });
}
