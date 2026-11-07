import { expect, test } from 'playwright/test';

test('a direct-folder failed save survives reload and can only be copied safely', async ({ page }) => {
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.addInitScript(() => {
        type MockFile = { kind: 'file'; name: string; textValue: string; getFile: () => Promise<File>; createWritable: () => Promise<{ write: (value: string | Blob) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> };
        type MockDirectory = { kind: 'directory'; name: string; entries: Map<string, MockFile | MockDirectory>; values: () => AsyncIterableIterator<MockFile | MockDirectory>; getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<MockDirectory>; getFileHandle: (name: string, options?: { create?: boolean }) => Promise<MockFile>; removeEntry: (name: string) => Promise<void> };
        const missing = () => new DOMException('Entry not found', 'NotFoundError');
        const makeFile = (name: string, initial = ''): MockFile => {
            const file: MockFile = {
                kind: 'file', name, textValue: initial,
                getFile: async () => new File([file.textValue], name, { type: 'text/markdown' }),
                createWritable: async () => ({
                    write: async value => {
                        if (name.endsWith('.md') && (window as any).__failLocalNoteWrites) throw new Error('Simulated folder write failure');
                        file.textValue = typeof value === 'string' ? value : await value.text();
                    },
                    close: async () => {}, abort: async () => {}
                })
            };
            return file;
        };
        const makeDirectory = (name: string): MockDirectory => {
            const directory: MockDirectory = {
                kind: 'directory', name, entries: new Map(),
                async *values() { yield* directory.entries.values(); },
                async getDirectoryHandle(child, options) {
                    let entry = directory.entries.get(child);
                    if (!entry && options?.create) { entry = makeDirectory(child); directory.entries.set(child, entry); }
                    if (!entry || entry.kind !== 'directory') throw missing();
                    return entry;
                },
                async getFileHandle(child, options) {
                    let entry = directory.entries.get(child);
                    if (!entry && options?.create) { entry = makeFile(child); directory.entries.set(child, entry); }
                    if (!entry || entry.kind !== 'file') throw missing();
                    return entry;
                },
                async removeEntry(child) { if (!directory.entries.delete(child)) throw missing(); }
            };
            return directory;
        };
        const root = makeDirectory('Recovery folder');
        root.entries.set('Local note.md', makeFile('Local note.md', '---\nid: local-recovery-note\ntitle: Local note\nlabel: local/recovery\n---\nSaved folder content'));
        Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => root });
        (window as any).__localRoot = root;
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open Local Folder' }).first().click();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill('local/recovery');
    await search.press('Enter');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toContainText('Saved folder content');
    await page.evaluate(() => { (window as any).__failLocalNoteWrites = true; });
    await editor.fill('Unsaved folder content');
    await expect(page.getByRole('alert')).toContainText('Simulated folder write failure');
    await page.reload();
    await page.getByRole('button', { name: 'Open Local Folder' }).first().click();
    const review = page.getByRole('dialog', { name: 'Review saved drafts' });
    await expect(review).toContainText('Unsaved folder content');
    await expect(review.getByRole('button', { name: 'Restore in note' })).toHaveCount(0);
    await review.getByRole('button', { name: 'Save as new note' }).click();
    await expect(review).toBeHidden();
    const result = await page.evaluate(async () => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        const notes = Object.values(useStore.getState().blocksById);
        const root = (window as any).__localRoot as { entries: Map<string, { textValue?: string }> };
        return { notes, original: root.entries.get('Local note.md')?.textValue };
    });
    expect(result.original).toContain('Saved folder content');
    expect(result.notes).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Local note (recovered)', content: 'Unsaved folder content' })]));
});
