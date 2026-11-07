import { expect, test } from 'playwright/test';

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

test('restores a deleted note with its original ID, metadata, and body', async ({ request }) => {
    const label = `history:restore-${Date.now()}`;
    const originalResponse = await request.post('/api/blocks', {
        data: { title: 'Restored title', label, content: 'before $x^2$ after' }
    });
    expect(originalResponse.ok()).toBeTruthy();
    const original = await originalResponse.json();
    expect((await request.delete(`/api/blocks/${original.id}`)).ok()).toBeTruthy();

    const restoredResponse = await request.post('/api/blocks/restore', { data: original });
    expect(restoredResponse.ok()).toBeTruthy();
    const restored = await restoredResponse.json();
    expect(restored).toMatchObject({ id: original.id, title: 'Restored title', label, content: 'before $x^2$ after' });
    const read = await request.get(`/api/blocks/${original.id}`);
    expect(read.ok()).toBeTruthy();
    expect(await read.json()).toMatchObject({ id: original.id, label, content: 'before $x^2$ after' });
});

test('refuses restore when its ID or label has been claimed', async ({ request }) => {
    const label = `history:collision-${Date.now()}`;
    const created = await (await request.post('/api/blocks', {
        data: { title: 'Original', label, content: 'saved body' }
    })).json();
    expect((await request.post('/api/blocks/restore', { data: created })).status()).toBe(409);

    expect((await request.delete(`/api/blocks/${created.id}`)).ok()).toBeTruthy();
    const replacement = await request.post('/api/blocks', { data: { title: 'Replacement', label, content: '' } });
    expect(replacement.ok()).toBeTruthy();
    expect((await request.post('/api/blocks/restore', { data: created })).status()).toBe(409);
    expect((await request.get(`/api/blocks/${created.id}`)).status()).toBe(404);
});

test('requires complete note content for restoration', async ({ request }) => {
    const response = await request.post('/api/blocks/restore', {
        data: { id: `history-incomplete-${Date.now()}`, title: 'Incomplete', label: `history:incomplete-${Date.now()}` }
    });
    expect(response.status()).toBe(400);
});

test('a reviewed inverse relabel restores labels and incoming references', async ({ request }) => {
    const scope = `history-relabel-${Date.now()}`;
    const originalLabel = `${scope}/Old`;
    const newLabel = `${scope}/New`;
    const note = await (await request.post('/api/blocks', {
        data: { title: 'Target', label: originalLabel, content: 'target body' }
    })).json();
    const source = await (await request.post('/api/blocks', {
        data: { title: 'Source', label: `${scope}/Source`, content: `See [[${originalLabel}]].` }
    })).json();

    const applyRelabel = async (oldPrefix: string, newPrefix: string) => {
        const previewResponse = await request.post('/api/relabel/preview', { data: { oldPrefix, newPrefix } });
        expect(previewResponse.ok()).toBeTruthy();
        const plan = await previewResponse.json();
        expect(plan.conflicts).toEqual([]);
        const commitResponse = await request.post('/api/relabel/commit', {
            data: { oldPrefix, newPrefix, revision: plan.revision, signature: plan.signature }
        });
        expect(commitResponse.ok()).toBeTruthy();
    };

    await applyRelabel(originalLabel, newLabel);
    await applyRelabel(newLabel, originalLabel);
    expect(await (await request.get(`/api/blocks/${note.id}`)).json()).toMatchObject({ label: originalLabel, content: 'target body' });
    expect(await (await request.get(`/api/blocks/${source.id}`)).json()).toMatchObject({ content: `See [[${originalLabel}]].` });
});
