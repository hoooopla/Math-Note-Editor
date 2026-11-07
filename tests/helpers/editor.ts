import { expect, type Locator, type Page } from 'playwright/test';

export async function openEditor(page: Page) {
    const runtime = await page.request.get('/api/runtime');
    expect(runtime.ok()).toBeTruthy();
    expect(await runtime.json()).toMatchObject({ testMode: true, desktop: false });

    await page.goto('/');
    await expect(page.getByLabel('In-memory test mode')).toBeVisible();
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    return editor;
}

export async function replaceEditorText(page: Page, editor: Locator, text: string) {
    // CodeMirror may replace its content DOM while an earlier save finishes.
    await expect(async () => {
        await editor.focus();
        await expect(editor).toBeFocused({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
    await editor.fill(text);
}
