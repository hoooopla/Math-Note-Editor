import { expect, test } from 'playwright/test';

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

test('workspace confirmation keeps focus inside and returns it to its trigger', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Create new block' });
    await trigger.focus();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Create note' });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Create note' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
});

test('block search is a dialog with keyboard reachable results and focus return', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Search', exact: true });
    await trigger.focus();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Search blocks' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('textbox', { name: 'Search blocks' });
    await expect(input).toBeFocused();
    await input.fill('Welcome');
    await expect(dialog.getByRole('button', { name: /Welcome to Math Note Editor/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: /Welcome to Math Note Editor/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
});

test('graph dialog closes with Escape and returns focus', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Open graph view' });
    await trigger.focus();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Graph View' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
});

test('draft review fits a narrow screen, traps focus, and can be reopened', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Mobile recovery', label: 'accessibility:recovery', content: 'saved'
    } })).json();
    expect((await request.put(`/api/recovery/${note.id}`, { data: {
        id: note.id, title: note.title, label: note.label, content: 'draft',
        baseRevision: note.revision, updatedAt: Date.now()
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Review saved drafts' });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    const close = dialog.getByRole('button', { name: 'Close draft review' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Restore in note' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const reopen = page.getByRole('button', { name: 'Review drafts' });
    await reopen.focus();
    await reopen.click();
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(reopen).toBeFocused();
});

test('image picker traps focus and returns it to the editor', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Search assets' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(editor).toBeFocused();
});

test('workspace issue review has a named dialog and keyboard reachable repair controls', async ({ page, request }) => {
    const label = `accessibility-duplicate-${Date.now()}`;
    expect((await request.post('/api/test/duplicate-labels', { data: { label } })).ok()).toBeTruthy();
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Duplicate labels need attention' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close workspace issues' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Review later' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Open to rename' }).first().click();
    await expect(dialog.getByRole('textbox', { name: 'Block label' })).toBeFocused();
});
