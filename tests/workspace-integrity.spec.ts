import { expect, test } from 'playwright/test';

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

test('stale note writes and deletes preserve the newer version', async ({ request }) => {
    const created = await (await request.post('/api/blocks', { data: {
        title: 'Integrity note', label: 'integrity:note', content: 'first'
    } })).json();
    expect(created.revision).toMatch(/^[a-f0-9]{64}$/);
    const saved = await request.put(`/api/blocks/${created.id}`, { data: {
        title: created.title, label: created.label, content: 'second', baseRevision: created.revision
    } });
    expect(saved.ok()).toBeTruthy();
    const newer = (await saved.json()).block;
    const staleWrite = await request.put(`/api/blocks/${created.id}`, { data: {
        title: created.title, label: created.label, content: 'stale', baseRevision: created.revision
    } });
    expect(staleWrite.status()).toBe(409);
    expect((await staleWrite.json()).currentBlock.content).toBe('second');
    expect((await request.delete(`/api/blocks/${created.id}`, { data: { baseRevision: created.revision } })).status()).toBe(409);
    expect((await request.get(`/api/blocks/${created.id}`)).ok()).toBeTruthy();
    expect((await request.delete(`/api/blocks/${created.id}`, { data: { baseRevision: newer.revision } })).ok()).toBeTruthy();
});

test('malformed preferences cannot replace valid settings', async ({ request }) => {
    const good = { macros: {}, customCommands: [], textCommands: [], searchShortcut: 'mod+k' };
    expect((await request.post('/api/settings', { data: good })).ok()).toBeTruthy();
    expect((await request.post('/api/settings', { data: { ...good, searchShortcut: 42 } })).status()).toBe(400);
    expect((await (await request.get('/api/settings')).json()).searchShortcut).toBe('mod+k');
});

test('an externally malformed settings file cannot break keyboard shortcuts', async ({ page }) => {
    await page.route('**/api/settings', route => route.fulfill({ json: {
        macros: {}, customCommands: [], textCommands: [], searchShortcut: 42
    } }));
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('preferences are invalid');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByPlaceholder('Search blocks or create new...')).toBeVisible();
});

test('a conflicted save keeps the local editor draft and the newer stored note', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Conflict draft', label: 'integrity:conflict', content: 'original'
    } })).json();
    await page.route('**/api/events', route => route.abort());
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill('integrity:conflict');
    await search.press('Enter');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toContainText('original');
    const remote = await request.put(`/api/blocks/${note.id}`, { data: {
        title: note.title, label: note.label, content: 'remote newer', baseRevision: note.revision
    } });
    expect(remote.ok()).toBeTruthy();
    await editor.fill('my unsaved draft');
    await expect(page.getByRole('alert')).toContainText('changed elsewhere');
    await expect(editor).toContainText('my unsaved draft');
    expect((await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('remote newer');
});

test('an unsaved draft survives reload and can be restored without changing the note first', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Recover me', label: 'integrity:recovery', content: 'saved text'
    } })).json();
    await page.goto('/');
    await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        useStore.getState().updateBlock(id, { content: 'unsaved text' });
    }, note.id);
    await expect.poll(async () => (await (await request.get('/api/recovery')).json()).drafts.some((draft: { id: string }) => draft.id === note.id)).toBe(true);
    await page.route(`**/api/blocks/${note.id}`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { error: 'Simulated save failure' } }) : route.continue());
    await expect(page.getByRole('alert')).toContainText('Simulated save failure');
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Review saved drafts' })).toBeVisible();
    await expect(page.getByText('unsaved text')).toBeVisible();
    await page.unroute(`**/api/blocks/${note.id}`);
    await page.getByRole('button', { name: 'Restore in note' }).click();
    await expect.poll(async () => (await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('unsaved text');
    await expect.poll(async () => (await (await request.get('/api/recovery')).json()).drafts.length).toBe(0);
});

test('an abrupt page exit sends a pending recovery draft before the debounce fires', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Exit recovery', label: 'integrity:exit-recovery', content: 'saved before exit'
    } })).json();
    await page.route(`**/api/blocks/${note.id}`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { error: 'Simulated disk failure' } }) : route.continue());
    await page.goto('/');
    await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        useStore.getState().updateBlock(id, { content: 'pending when page exits' });
    }, note.id);
    await page.goto('about:blank');
    await expect.poll(async () => (await (await request.get('/api/recovery')).json()).drafts
        .find((draft: { id: string }) => draft.id === note.id)?.content).toBe('pending when page exits');
    expect((await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('saved before exit');
});

test('a recovered draft makes a separate note when the saved note changed', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Keep both', label: 'integrity:keep-both', content: 'original'
    } })).json();
    await page.goto('/');
    await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        useStore.getState().updateBlock(id, { content: 'local draft' });
    }, note.id);
    await expect.poll(async () => (await (await request.get('/api/recovery')).json()).drafts.length).toBe(1);
    await page.route(`**/api/blocks/${note.id}`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { error: 'Simulated save failure' } }) : route.continue());
    await expect(page.getByRole('alert')).toContainText('Simulated save failure');
    const remote = await request.put(`/api/blocks/${note.id}`, { data: {
        title: note.title, label: note.label, content: 'remote change', baseRevision: note.revision
    } });
    expect(remote.ok()).toBeTruthy();
    await page.reload();
    const dialog = page.getByRole('dialog', { name: 'Review saved drafts' });
    await expect(dialog).toContainText('saved note has changed');
    await expect(dialog.getByRole('button', { name: 'Restore in note' })).toHaveCount(0);
    await page.unroute(`**/api/blocks/${note.id}`);
    await dialog.getByRole('button', { name: 'Save as new note' }).click();
    await expect.poll(async () => (await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('remote change');
    await expect.poll(async () => ((await (await request.get('/api/blocks')).json()) as Array<{ title: string }>).some(block => block.title === 'Keep both (recovered)')).toBe(true);
});

test('server recovery still works when browser storage rejects a draft', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Server fallback', label: 'integrity:server-fallback', content: 'saved'
    } })).json();
    await page.goto('/');
    await page.route(`**/api/blocks/${note.id}`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { error: 'Simulated save failure' } }) : route.continue());
    await page.evaluate(async id => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key.startsWith('math-note-recovery:')) throw new DOMException('Storage full', 'QuotaExceededError');
            return original.call(this, key, value);
        };
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        useStore.getState().updateBlock(id, { content: 'draft despite storage failure' });
    }, note.id);
    await expect.poll(async () => (await (await request.get('/api/recovery')).json()).drafts[0]?.content).toBe('draft despite storage failure');
    await expect(page.getByRole('alert')).toContainText('Simulated save failure');
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Review saved drafts' })).toContainText('Server fallback');
});

test('restoring a title-only draft keeps the saved body', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Original title', label: 'integrity:title-only', content: 'body stays intact'
    } })).json();
    await page.goto('/');
    await page.route(`**/api/blocks/${note.id}`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { error: 'Simulated save failure' } }) : route.continue());
    await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        useStore.getState().updateBlock(id, { title: 'Recovered title' });
    }, note.id);
    await expect.poll(async () => (await (await request.get('/api/recovery')).json()).drafts[0]?.title).toBe('Recovered title');
    await expect(page.getByRole('alert')).toContainText('Simulated save failure');
    await page.reload();
    await page.unroute(`**/api/blocks/${note.id}`);
    await page.getByRole('dialog', { name: 'Review saved drafts' }).getByRole('button', { name: 'Restore in note' }).click();
    await expect.poll(async () => (await (await request.get(`/api/blocks/${note.id}`)).json()).title).toBe('Recovered title');
    expect((await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('body stays intact');
});

test('a damaged recovery record does not hide valid drafts', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Valid draft', label: 'integrity:valid-draft', content: 'saved'
    } })).json();
    await page.route('**/api/recovery', route => route.fulfill({ json: {
        drafts: [{ id: note.id, title: note.title, label: note.label, content: 'recover this',
            baseRevision: note.revision, updatedAt: Date.now() }],
        errors: ['damaged.json: invalid JSON']
    } }));
    await page.goto('/');
    await expect(page.getByRole('dialog', { name: 'Review saved drafts' })).toContainText('recover this');
    await expect(page.getByRole('alert')).toContainText('damaged.json');
});

test('a valid server draft can be copied and dismissed with damaged browser recovery data', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Server draft with bad cache', label: 'integrity:bad-cache', content: 'saved body'
    } })).json();
    expect((await request.put(`/api/recovery/${note.id}`, { data: {
        id: note.id, title: note.title, label: note.label, content: 'draft from disk',
        baseRevision: note.revision, updatedAt: Date.now()
    } })).ok()).toBeTruthy();
    await page.addInitScript(() => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key: string) {
            return key.startsWith('math-note-recovery:') ? '{damaged browser cache' : original.call(this, key);
        };
    });
    await page.goto('/');
    const review = page.getByRole('dialog', { name: 'Review saved drafts' });
    await expect(review).toContainText('draft from disk');
    await review.getByRole('button', { name: 'Save as new note' }).click();
    await expect(review).toBeHidden();
    await expect.poll(async () => (await (await request.get('/api/recovery')).json()).drafts.length).toBe(0);
    expect((await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('saved body');
});

test('relabel advances revisions before the next edit even without server events', async ({ page, request }) => {
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Revision after relabel', label: 'integrity:before', content: 'original'
    } })).json();
    await page.route('**/api/events', route => route.abort());
    await page.goto('/');
    await page.evaluate(async () => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        const plan = await useStore.getState().previewRelabel('integrity:before', 'integrity:after');
        await useStore.getState().commitRelabel(plan);
    });
    const transformed = await (await request.get(`/api/blocks/${note.id}`)).json();
    expect(transformed.revision).not.toBe(note.revision);
    const localRevision = await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        return useStore.getState().blocksById[id].revision;
    }, note.id);
    expect(localRevision).toBe(transformed.revision);
    await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        useStore.getState().updateBlock(id, { content: 'edited after relabel' });
        await useStore.getState().flushBlock(id);
    }, note.id);
    expect((await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('edited after relabel');
});

test('asset move advances affected note revisions before the next edit', async ({ page, request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    expect((await request.post('/api/assets', { data: { filePath: 'assets/revision-old.gif', content: gif } })).ok()).toBeTruthy();
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Revision after image move', label: 'integrity:image', content: '<img src="assets/revision-old.gif" />'
    } })).json();
    await page.route('**/api/events', route => route.abort());
    await page.goto('/');
    await page.evaluate(async () => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        const plan = await useStore.getState().previewAssetMove('assets/revision-old.gif', 'assets/revision-new.gif');
        await useStore.getState().commitAssetMove(plan);
    });
    const transformed = await (await request.get(`/api/blocks/${note.id}`)).json();
    expect(transformed.revision).not.toBe(note.revision);
    const localRevision = await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        return useStore.getState().blocksById[id].revision;
    }, note.id);
    expect(localRevision).toBe(transformed.revision);
    await page.evaluate(async id => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        useStore.getState().updateBlock(id, { content: 'edited after image move' });
        await useStore.getState().flushBlock(id);
    }, note.id);
    expect((await (await request.get(`/api/blocks/${note.id}`)).json()).content).toBe('edited after image move');
});

test('all notes search states its cap and warns when a note cannot be read', async ({ page, request }) => {
    const block = await (await request.post('/api/blocks', { data: {
        title: 'Unreadable search note', label: 'integrity:unreadable', content: 'secretneedle'
    } })).json();
    await page.route(`**/api/blocks/${block.id}`, route => route.fulfill({ status: 500, json: { error: 'temporarily unreadable' } }));
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Search scope').selectOption('all');
    await find.getByLabel('Find in content').fill('secretneedle');
    await expect(find).toContainText('Results are limited to 200 matches per note');
    await expect(find).toContainText('results are incomplete');
    await expect(find).toContainText('No matches in readable notes');
});
