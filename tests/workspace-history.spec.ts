import { expect, test, type APIRequestContext, type Page } from 'playwright/test';

type Note = { id: string; title: string; label: string; content: string };

const unique = (name: string) => `history-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

async function createNote(request: APIRequestContext, label: string, content = '', title = label): Promise<Note> {
    const response = await request.post('/api/blocks', { data: { title, label, content } });
    expect(response.ok()).toBeTruthy();
    return await response.json();
}

async function readNote(request: APIRequestContext, id: string): Promise<Note> {
    const response = await request.get(`/api/blocks/${id}`);
    expect(response.ok()).toBeTruthy();
    return await response.json();
}

async function noteExists(request: APIRequestContext, id: string): Promise<boolean> {
    const response = await request.get('/api/blocks?metaOnly=true');
    expect(response.ok()).toBeTruthy();
    const notes = await response.json() as Array<{ id: string }>;
    return notes.some(note => note.id === id);
}

async function openApp(page: Page) {
    await page.goto('/');
    await expect(page.getByLabel('In-memory test mode')).toBeVisible();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeVisible();
}

async function openNote(page: Page, label: string) {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(label);
    await search.press('Enter');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    return editor;
}

async function confirmHistory(page: Page, direction: 'Undo' | 'Redo') {
    const dialog = page.getByRole('dialog', { name: new RegExp(`^${direction}\\b`, 'i') });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: direction, exact: true }).click();
    await expect(dialog).toBeHidden();
}

test('undoing across tabs asks first, then keeps repeated undo available', async ({ page, request }) => {
    const first = await createNote(request, unique('first'), 'first body', 'First history note');
    const second = await createNote(request, unique('second'), 'second body', 'Second history note');
    await openApp(page);

    const firstEditor = await openNote(page, first.label);
    await firstEditor.fill('first changed');
    await expect.poll(async () => (await readNote(request, first.id)).content).toBe('first changed');

    const secondEditor = await openNote(page, second.label);
    await secondEditor.fill('second changed');
    await expect.poll(async () => (await readNote(request, second.id)).content).toBe('second changed');

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await readNote(request, second.id)).content).toBe('second body');

    await page.keyboard.press('ControlOrMeta+z');
    const dialog = page.getByRole('dialog', { name: /^Undo\b/i });
    await expect(dialog).toContainText('First history note');
    expect((await readNote(request, first.id)).content).toBe('first changed');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await readNote(request, first.id)).content).toBe('first changed');

    await page.keyboard.press('ControlOrMeta+z');
    await confirmHistory(page, 'Undo');
    await expect.poll(async () => (await readNote(request, first.id)).content).toBe('first body');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    const redoDialog = page.getByRole('dialog', { name: /^Redo\b/i });
    if (await redoDialog.isVisible()) await redoDialog.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await readNote(request, first.id)).content).toBe('first changed');
});

test('a failed undo retains the edit and can be retried', async ({ page, request }) => {
    const note = await createNote(request, unique('undo-failure'), 'saved body', 'Undo failure note');
    await openApp(page);
    const editor = await openNote(page, note.label);
    await editor.fill('edited body');
    await expect.poll(async () => (await readNote(request, note.id)).content).toBe('edited body');

    await page.route(`**/api/blocks/${note.id}`, route => {
        if (route.request().method() === 'PUT' && route.request().postDataJSON()?.content === 'saved body') {
            return route.fulfill({ status: 500, json: { error: 'Undo storage failed' } });
        }
        return route.continue();
    });
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByRole('alert')).toContainText('Undo storage failed');
    await expect(editor).toContainText('edited body');
    expect((await readNote(request, note.id)).content).toBe('edited body');

    await page.unroute(`**/api/blocks/${note.id}`);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await readNote(request, note.id)).content).toBe('saved body');
});

test('a new edit after undo clears the old redo branch', async ({ page, request }) => {
    const note = await createNote(request, unique('redo-branch'), 'original', 'Redo branch note');
    await openApp(page);
    const editor = await openNote(page, note.label);
    await editor.fill('first edit');
    await expect.poll(async () => (await readNote(request, note.id)).content).toBe('first edit');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await readNote(request, note.id)).content).toBe('original');
    await editor.fill('new branch');
    await expect.poll(async () => (await readNote(request, note.id)).content).toBe('new branch');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect((await readNote(request, note.id)).content).toBe('new branch');
    const redoLabel = await page.evaluate(async () => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        return useStore.getState().historyState.redoLabel;
    });
    expect(redoLabel).toBeUndefined();
});

test('a second Undo during a slow save waits and then asks before crossing tabs', async ({ page, request }) => {
    const first = await createNote(request, unique('queued-first'), 'first body', 'First queued note');
    const second = await createNote(request, unique('queued-second'), 'second body', 'Second queued note');
    await openApp(page);
    const firstEditor = await openNote(page, first.label);
    await firstEditor.fill('first changed');
    await expect.poll(async () => (await readNote(request, first.id)).content).toBe('first changed');
    const secondEditor = await openNote(page, second.label);
    await secondEditor.fill('second changed');
    await expect.poll(async () => (await readNote(request, second.id)).content).toBe('second changed');

    let releaseSave!: () => void;
    let sawSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const saveStarted = new Promise<void>(resolve => { sawSave = resolve; });
    await page.route(`**/api/blocks/${second.id}`, async route => {
        if (route.request().method() === 'PUT' && route.request().postDataJSON()?.content === 'second body') {
            sawSave();
            await saveGate;
        }
        await route.continue();
    });
    await page.keyboard.press('ControlOrMeta+z');
    await saveStarted;
    await page.keyboard.press('ControlOrMeta+z');
    releaseSave();
    const dialog = page.getByRole('dialog', { name: /^Undo\b/i });
    await expect(dialog).toContainText('First queued note');
    expect((await readNote(request, first.id)).content).toBe('first changed');
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await readNote(request, first.id)).content).toBe('first body');
});

test('undo and redo creation from label autocomplete restore the same note', async ({ page, request }) => {
    const source = await createNote(request, unique('source'), '', 'Autocomplete source');
    const label = unique('completion');
    await openApp(page);
    const editor = await openNote(page, source.label);
    await editor.fill(`[[${label}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await page.getByText(`Create new block: "${label}"`, { exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: /create note/i });
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole('button', { name: 'Create note' }).click();

    let created: Note | undefined;
    await expect.poll(async () => {
        const response = await request.get('/api/blocks?metaOnly=true');
        const notes = await response.json() as Note[];
        created = notes.find(note => note.label === label);
        return Boolean(created);
    }).toBe(true);
    const id = created!.id;

    await page.keyboard.press('ControlOrMeta+z');
    await confirmHistory(page, 'Undo');
    await expect.poll(() => noteExists(request, id)).toBe(false);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await confirmHistory(page, 'Redo');
    await expect.poll(() => noteExists(request, id)).toBe(true);
    expect((await readNote(request, id)).label).toBe(label);
});

test('undo and redo deletion preserve the note identity and body', async ({ page, request }) => {
    const note = await createNote(request, unique('delete'), 'body to recover', 'Delete history note');
    await openApp(page);
    await openNote(page, note.label);
    const header = page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]');
    await header.getByRole('button', { name: 'More block actions' }).click();
    await header.getByRole('button', { name: 'Delete note…' }).click();
    const deleteDialog = page.getByRole('dialog', { name: /delete note/i });
    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog).toContainText('Note affected');
    await expect(deleteDialog).toContainText(note.title);
    await expect(deleteDialog).toContainText(note.label);
    await expect(deleteDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await deleteDialog.getByRole('button', { name: 'Delete note' }).click();
    await expect.poll(() => noteExists(request, note.id)).toBe(false);

    await page.keyboard.press('ControlOrMeta+z');
    await confirmHistory(page, 'Undo');
    await expect.poll(() => noteExists(request, note.id)).toBe(true);
    expect(await readNote(request, note.id)).toMatchObject({ title: note.title, label: note.label, content: note.content });

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await confirmHistory(page, 'Redo');
    await expect.poll(() => noteExists(request, note.id)).toBe(false);
});

test('a title change requires confirmation and can be undone and redone', async ({ page, request }) => {
    const note = await createNote(request, unique('title'), 'stable body', 'Original history title');
    await openApp(page);
    await openNote(page, note.label);
    const header = page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]');
    await header.dblclick();
    await page.getByLabel('Block title').fill('Revised history title');
    await page.getByLabel('Save block metadata').click();

    const titleDialog = page.getByRole('dialog', { name: 'Change title' });
    await expect(titleDialog).toBeVisible();
    expect((await readNote(request, note.id)).title).toBe(note.title);
    await titleDialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await readNote(request, note.id)).title).toBe(note.title);

    await header.dblclick();
    await page.getByLabel('Block title').fill('Revised history title');
    await page.getByLabel('Save block metadata').click();
    await titleDialog.getByRole('button', { name: 'Change title' }).click();
    await expect.poll(async () => (await readNote(request, note.id)).title).toBe('Revised history title');

    await page.keyboard.press('ControlOrMeta+z');
    await confirmHistory(page, 'Undo');
    await expect.poll(async () => (await readNote(request, note.id)).title).toBe(note.title);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await confirmHistory(page, 'Redo');
    await expect.poll(async () => (await readNote(request, note.id)).title).toBe('Revised history title');
});

test('safe relabel, including incoming references, is one reversible step', async ({ page, request }) => {
    const oldLabel = unique('old');
    const newLabel = unique('new');
    const target = await createNote(request, oldLabel, 'target body', 'Relabel target');
    const source = await createNote(request, unique('ref'), `see [[${oldLabel}]]`, 'Relabel source');
    await openApp(page);
    await openNote(page, target.label);
    const header = page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]');
    await header.dblclick();
    await page.getByLabel('Block label').fill(newLabel);
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText('Tree transformation', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Rename node|Move and rename subtree/ }).click();
    await page.getByRole('dialog', { name: 'Tree transformation complete' }).getByRole('button', { name: 'Done' }).click();
    await expect.poll(async () => (await readNote(request, target.id)).label).toBe(newLabel);
    expect((await readNote(request, source.id)).content).toContain(`[[${newLabel}]]`);

    await page.keyboard.press('ControlOrMeta+z');
    const undoDialog = page.getByRole('dialog', { name: /^Undo Rename/ });
    await expect(undoDialog.getByText('From', { exact: true })).toBeVisible();
    await expect(undoDialog.getByText('To', { exact: true })).toBeVisible();
    await expect(undoDialog.locator('ul li')).toHaveCount(2);
    await expect(undoDialog.locator('ul li').filter({ hasText: 'Relabel target' })).toHaveCount(1);
    await expect(undoDialog.locator('ul li').filter({ hasText: 'Relabel source' })).toHaveCount(1);
    await expect(undoDialog.getByText(newLabel, { exact: true }).first()).toBeVisible();
    await expect(undoDialog.getByText(oldLabel, { exact: true }).first()).toBeVisible();
    await confirmHistory(page, 'Undo');
    await expect.poll(async () => (await readNote(request, target.id)).label).toBe(oldLabel);
    expect((await readNote(request, source.id)).content).toContain(`[[${oldLabel}]]`);

    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    const redoDialog = page.getByRole('dialog', { name: /^Redo Rename/ });
    await expect(redoDialog.locator('ul li')).toHaveCount(2);
    await confirmHistory(page, 'Redo');
    await expect.poll(async () => (await readNote(request, target.id)).label).toBe(newLabel);
    expect((await readNote(request, source.id)).content).toContain(`[[${newLabel}]]`);
});

test('a combined title and label change undoes as one step', async ({ page, request }) => {
    const oldLabel = unique('combined-old');
    const newLabel = unique('combined-new');
    const note = await createNote(request, oldLabel, 'unchanged body', 'Old combined title');
    await openApp(page);
    await openNote(page, oldLabel);
    const header = page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]');
    await header.dblclick();
    await page.getByLabel('Block title').fill('New combined title');
    await page.getByLabel('Block label').fill(newLabel);
    await page.getByLabel('Save block metadata').click();
    await page.getByRole('button', { name: /Rename node|Move and rename subtree/ }).click();
    await page.getByRole('dialog', { name: 'Tree transformation complete' }).getByRole('button', { name: 'Done' }).click();
    await expect.poll(async () => {
        const current = await readNote(request, note.id);
        return { title: current.title, label: current.label };
    }).toEqual({ title: 'New combined title', label: newLabel });

    await page.keyboard.press('ControlOrMeta+z');
    await confirmHistory(page, 'Undo');
    await expect.poll(async () => {
        const current = await readNote(request, note.id);
        return { title: current.title, label: current.label };
    }).toEqual({ title: note.title, label: oldLabel });
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await confirmHistory(page, 'Redo');
    await expect.poll(async () => {
        const current = await readNote(request, note.id);
        return { title: current.title, label: current.label };
    }).toEqual({ title: 'New combined title', label: newLabel });
});

test('moving an image across notes can be undone and redone', async ({ page, request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    const oldPath = 'assets/history-old.gif';
    const newPath = 'assets/history-new.gif';
    expect((await request.post('/api/assets', { data: { filePath: oldPath, content: gif } })).ok()).toBeTruthy();
    const first = await createNote(request, unique('image-first'), `![first](${oldPath})`, 'First image note');
    const second = await createNote(request, unique('image-second'), `<img src="${oldPath}" alt="second" />`, 'Second image note');
    await openApp(page);
    await page.getByLabel('Open settings').click();
    const settings = page.getByRole('dialog', { name: 'Editor Settings' });
    await settings.getByText('Manage Assets', { exact: true }).first().click();
    const manager = settings.getByRole('region', { name: 'Manage Assets' });
    await manager.getByRole('button', { name: 'history-old.gif' }).click();
    await manager.getByLabel('New path inside assets').fill('history-new.gif');
    await manager.getByRole('button', { name: 'Review rename / move' }).click();
    await expect(manager.getByTestId('asset-move-preview')).toContainText('2 affected notes');
    await manager.getByRole('button', { name: 'Confirm move' }).click();
    await expect(manager.getByRole('status')).toContainText('Updated 2 notes');
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect.poll(async () => (await readNote(request, first.id)).content).toContain(newPath);
    await expect.poll(async () => (await readNote(request, second.id)).content).toContain(newPath);
    expect((await request.get(`/api/${newPath}`)).ok()).toBe(true);

    await page.keyboard.press('ControlOrMeta+z');
    await confirmHistory(page, 'Undo');
    await expect.poll(async () => (await readNote(request, first.id)).content).toContain(oldPath);
    await expect.poll(async () => (await readNote(request, second.id)).content).toContain(oldPath);
    expect((await request.get(`/api/${oldPath}`)).ok()).toBe(true);
    expect((await request.get(`/api/${newPath}`)).ok()).toBe(false);

    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await confirmHistory(page, 'Redo');
    await expect.poll(async () => (await readNote(request, first.id)).content).toContain(newPath);
    await expect.poll(async () => (await readNote(request, second.id)).content).toContain(newPath);
    expect((await request.get(`/api/${newPath}`)).ok()).toBe(true);
});
