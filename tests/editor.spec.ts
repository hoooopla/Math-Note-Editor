import { expect, test, type Locator, type Page } from 'playwright/test';
import path from 'node:path';
import { computeReferences, metadataText, parseFrontmatter, stringifyFrontmatter } from '../src/lib/block-metadata';
import { encodeEmbeddedLabel, findActiveEmbeddedTarget, parseEmbeddedLinks } from '../src/lib/embedded-link-syntax';
import { makeBlockFilename, validateBlockLabel } from '../src/lib/label-policy';
import { applySafeRelabelPlan, buildSafeRelabelPlan, relabelPlanSignatureInput } from '../src/lib/safe-relabel';
import { findDuplicateLabelIssues } from '../src/lib/workspace-validation';

test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset');
    expect(response.ok()).toBeTruthy();
});

async function openEditor(page: Page) {
    const runtime = await page.request.get('/api/runtime');
    expect(runtime.ok()).toBeTruthy();
    expect(await runtime.json()).toMatchObject({ testMode: true, desktop: false });

    await page.goto('/');
    await expect(page.getByLabel('In-memory test mode')).toBeVisible();
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    return editor;
}

async function replaceEditorText(page: Page, editor: Locator, text: string) {
    await editor.focus();
    await expect(editor).toBeFocused();
    // Playwright's contenteditable fill emits one deterministic input update.
    // Character-by-character typing is slow for large documents and the
    // platform's Select All shortcut can race CodeMirror's focus effects.
    await editor.fill(text);
}

test('derives references from content without persisting duplicate metadata', async ({ request }) => {
    const content = '[[target]] [[target || Alias]] [[/child∨]] [[@standout]]';
    expect(computeReferences(content)).toEqual(['target', '/child', 'standout']);
    expect(stringifyFrontmatter({
        id: 'reference-test',
        title: 'Reference test',
        label: 'reference-test',
        references: ['stale-value']
    }, content)).not.toContain('references:');

    const created = await (await request.post('/api/blocks', {
        data: { title: 'Reference test', label: 'reference-test', content }
    })).json();
    expect(created.references).toEqual(['target', '/child', 'standout']);

    const metadata = await (await request.get('/api/blocks?metaOnly=true')).json();
    expect(metadata.find((block: { id: string }) => block.id === created.id)?.references)
        .toEqual(['target', '/child', 'standout']);
});

test('round-trips special-character labels with math-aware embed syntax', () => {
    const labels = [
        'Divisibility/$a|b$',
        'Norm/$||x||$',
        'Intervals/$[a,b]$',
        'Notes [draft]',
        'A || B',
        '@literal',
        '/literal',
        'logical∨'
    ];
    for (const label of labels) {
        const encoded = encodeEmbeddedLabel(label);
        const parsed = parseEmbeddedLinks(`[[${encoded}]]`);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].label).toBe(label);
        expect(parsed[0].alias).toBeNull();
        expect(parsed[0].standout).toBe(false);
        expect(parsed[0].open).toBe(false);
    }

    const source = 'See [[Norm/$||x||$||Visible $[x,y]$∨]] now';
    expect(parseEmbeddedLinks(source)[0]).toMatchObject({
        label: 'Norm/$||x||$',
        alias: 'Visible $[x,y]$',
        open: true
    });
    expect(computeReferences(source)).toEqual(['Norm/$||x||$']);

    const cursor = source.indexOf('x||$') + 1;
    expect(findActiveEmbeddedTarget(source, cursor)?.label).toBe('Norm/$||x||$');
});

test('round-trips YAML metadata and creates bounded readable filenames', () => {
    const title = 'Definition: $A[1]$ # important 🧮';
    const label = 'Topology/Hausdorff/Definition $A[1]$';
    const markdown = stringifyFrontmatter({ id: 'f26157d5', title, label, references: ['stale'] }, 'Body');
    const parsed = parseFrontmatter(markdown);
    expect(metadataText(parsed.data.title)).toBe(title);
    expect(metadataText(parsed.data.label)).toBe(label);
    expect(markdown).not.toContain('references:');

    const filename = makeBlockFilename(title, label, 'f26157d5');
    expect(filename).toContain('Definition');
    expect(filename).toContain('Hausdorff');
    expect(filename).toContain('f26157d5');
    expect(new TextEncoder().encode(filename).length).toBeLessThan(255);
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);
});

test('plans a sparse subtree relabel and preserves relative link meaning', () => {
    const blocks = [
        { id: 'root', title: 'Sparse root', label: 'A/B', content: 'Child [[/Child]]' },
        { id: 'child', title: 'Child', label: 'A/B/Child', content: '' },
        { id: 'source', title: 'Index', label: 'Index', content: 'See [[A/B/Child||Child alias∨]] and [[A/B/Future]]' }
    ];
    const plan = buildSafeRelabelPlan(blocks, 'A/B', 'Math/Groups');

    expect(plan.changeType).toBe('move-and-rename');
    expect(plan.conflicts).toEqual([]);
    expect(plan.blockChanges.map(change => [change.oldLabel, change.newLabel])).toEqual([
        ['A/B', 'Math/Groups'],
        ['A/B/Child', 'Math/Groups/Child']
    ]);
    expect(plan.referenceImpacts.find(impact => impact.oldText === '[[/Child]]')).toMatchObject({
        changed: false,
        oldTarget: 'A/B/Child',
        newTarget: 'Math/Groups/Child'
    });
    expect(plan.referenceImpacts.find(impact => impact.oldTarget === 'A/B/Future')).toMatchObject({
        changed: true,
        targetExists: false,
        newText: '[[Math/Groups/Future]]'
    });

    const applied = applySafeRelabelPlan(blocks, plan);
    expect(applied.find(block => block.id === 'root')?.content).toBe('Child [[/Child]]');
    expect(applied.find(block => block.id === 'source')?.content)
        .toBe('See [[Math/Groups/Child||Child alias∨]] and [[Math/Groups/Future]]');
});

test('safe relabel signature is stable when workspace enumeration order changes', () => {
    const blocks = [
        { id: 'root', title: 'Root', label: 'A/B', content: '[[/Child]]' },
        { id: 'child', title: 'Child', label: 'A/B/Child', content: '' },
        { id: 'source', title: 'Source', label: 'Index', content: '[[A/B]] [[A/B/Child]]' }
    ];
    const forward = buildSafeRelabelPlan(blocks, 'A/B', 'X/B');
    const reversed = buildSafeRelabelPlan([...blocks].reverse(), 'A/B', 'X/B');
    expect(relabelPlanSignatureInput(forward)).toBe(relabelPlanSignatureInput(reversed));
});

test('rejects relabel collisions and moving a node into its own subtree', () => {
    const blocks = [
        { id: 'one', title: 'One', label: 'A/B', content: '' },
        { id: 'child', title: 'Child', label: 'A/B/C', content: '' },
        { id: 'occupied', title: 'Occupied', label: 'X/B/C', content: '' }
    ];
    expect(buildSafeRelabelPlan(blocks, 'A/B', 'X/B').conflicts.join(' ')).toContain('already occupied');
    expect(buildSafeRelabelPlan(blocks, 'A/B', 'A/B/Nested').conflicts.join(' ')).toContain('own subtree');
});

test('previews and commits a revision-checked tree transformation', async ({ request }) => {
    const suffix = Date.now();
    const oldPrefix = `safe-${suffix}/missing-parent`;
    const newPrefix = `moved-${suffix}/new-parent`;
    const root = await (await request.post('/api/blocks', {
        data: { title: 'Safe root', label: oldPrefix, content: 'child [[/Child]]' }
    })).json();
    const child = await (await request.post('/api/blocks', {
        data: { title: 'Safe child', label: `${oldPrefix}/Child`, content: '' }
    })).json();
    const source = await (await request.post('/api/blocks', {
        data: { title: 'Safe source', label: `source-${suffix}`, content: `before [[${oldPrefix}/Child]] after` }
    })).json();

    const previewResponse = await request.post('/api/relabel/preview', { data: { oldPrefix, newPrefix } });
    expect(previewResponse.ok()).toBeTruthy();
    const preview = await previewResponse.json();
    expect(preview.conflicts).toEqual([]);
    expect(preview.blockChanges).toHaveLength(2);
    expect(preview.referenceImpacts.some((impact: { changed: boolean }) => impact.changed)).toBeTruthy();

    const commit = await request.post('/api/relabel/commit', {
        data: { oldPrefix, newPrefix, revision: preview.revision }
    });
    expect(commit.ok()).toBeTruthy();
    expect((await (await request.get(`/api/blocks/${root.id}`)).json()).label).toBe(newPrefix);
    expect((await (await request.get(`/api/blocks/${child.id}`)).json()).label).toBe(`${newPrefix}/Child`);
    expect((await (await request.get(`/api/blocks/${source.id}`)).json()).content).toContain(`[[${newPrefix}/Child]]`);
});

test('rejects stale relabel plans and direct label-change bypasses', async ({ request }) => {
    const suffix = Date.now();
    const oldPrefix = `stale-${suffix}`;
    const newPrefix = `fresh-${suffix}`;
    const block = await (await request.post('/api/blocks', {
        data: { title: 'Stale plan', label: oldPrefix, content: '' }
    })).json();
    const preview = await (await request.post('/api/relabel/preview', {
        data: { oldPrefix, newPrefix }
    })).json();

    const directRelabel = await request.put(`/api/blocks/${block.id}`, {
        data: { ...block, label: newPrefix }
    });
    expect(directRelabel.status()).toBe(409);
    expect((await directRelabel.json()).error).toContain('reviewed tree transformation');

    const titleUpdate = await request.put(`/api/blocks/${block.id}`, {
        data: { ...block, title: 'Changed after preview' }
    });
    expect(titleUpdate.ok()).toBeTruthy();
    const staleCommit = await request.post('/api/relabel/commit', {
        data: { oldPrefix, newPrefix, revision: preview.revision }
    });
    expect(staleCommit.status()).toBe(409);
    expect((await staleCommit.json()).error).toContain('workspace changed');
});

test('rejects invalid and duplicate labels at the server boundary', async ({ request }) => {
    const validLabel = `special/$A[1]|B$-${Date.now()}`;
    const created = await request.post('/api/blocks', {
        data: { title: 'Special label', label: validLabel, content: '' }
    });
    expect(created.ok()).toBeTruthy();

    const duplicate = await request.post('/api/blocks', {
        data: { title: 'Duplicate', label: validLabel, content: '' }
    });
    expect(duplicate.status()).toBe(409);

    for (const label of ['@reserved', '/reserved', 'bad\nlabel', `bad\u200blabel`, 'x'.repeat(513)]) {
        expect(validateBlockLabel(label)).not.toBeNull();
        const response = await request.post('/api/blocks', {
            data: { title: 'Invalid', label, content: '' }
        });
        expect(response.status()).toBe(400);
    }
});

test('rejects concurrent attempts to create the same label', async ({ request }) => {
    const label = `test:concurrent-create-${Date.now()}`;
    const responses = await Promise.all([
        request.post('/api/blocks', { data: { title: 'Concurrent A', label, content: '' } }),
        request.post('/api/blocks', { data: { title: 'Concurrent B', label, content: '' } })
    ]);
    expect(responses.map(response => response.status()).sort()).toEqual([200, 409]);
});

test('groups normalized duplicate labels without assigning either block as canonical', () => {
    const issues = findDuplicateLabelIssues([
        { id: 'one', title: 'One', label: ' Shared ', fileName: 'one.md' },
        { id: 'two', title: 'Two', label: 'Shared', fileName: 'two.md' },
        { id: 'three', title: 'Three', label: 'Unique', fileName: 'three.md' }
    ]);
    expect(issues).toEqual([{
        label: 'Shared',
        blocks: [
            { id: 'one', title: 'One', label: 'Shared', fileName: 'one.md' },
            { id: 'two', title: 'Two', label: 'Shared', fileName: 'two.md' }
        ]
    }]);
});

test('pauses duplicate blocks and repairs one through the workspace issues flow', async ({ page, request }) => {
    const label = `duplicate-import-${Date.now()}`;
    const seeded = await request.post('/api/test/duplicate-labels', { data: { label } });
    expect(seeded.ok()).toBeTruthy();

    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Duplicate labels need attention' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText(/duplicate label group needs attention/i)).toBeVisible();

    await dialog.getByRole('button', { name: 'Open to rename' }).first().click();
    const repairedLabel = `${label}-repaired`;
    await page.getByLabel('Block label').fill(repairedLabel);
    await page.getByLabel('Save block metadata').click();

    await expect(page.getByText(/duplicate label group needs attention/i)).not.toBeVisible();
    const metadata = await (await request.get('/api/blocks?metaOnly=true')).json();
    expect(metadata.filter((block: { label: string }) => block.label === label)).toHaveLength(1);
    expect(metadata.filter((block: { label: string }) => block.label === repairedLabel)).toHaveLength(1);
});

test('creates an exact safe search label and focuses the new root editor', async ({ page }) => {
    const label = `Mixed Case Search Label [${Date.now()}]`;
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(label);
    await expect(page.getByText(`Create "${label}"`, { exact: true })).toBeVisible();
    await search.press('Enter');

    await expect(search).not.toBeVisible();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(label);
    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.some((block: { label: string }) => block.label === label);
    }).toBe(true);
});

test('keeps invalid search creation open and does not create a block', async ({ page }) => {
    const invalidLabel = `@invalid-search-${Date.now()}`;
    await openEditor(page);
    const before = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(invalidLabel);
    await expect(page.getByText(/Label cannot start with @/)).toBeVisible();
    await search.press('Enter');

    await expect(search).toBeVisible();
    await expect(page.getByText(/Label cannot start with @/)).toBeVisible();
    const after = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    expect(after).toHaveLength(before.length);
});

test('validates header metadata and accepts brackets and math in labels', async ({ page }) => {
    await openEditor(page);
    const previousPanelId = await page.getByRole('tab', { selected: true }).getAttribute('aria-controls');
    await page.getByLabel('Create new block').click();
    await expect.poll(() => page.getByRole('tab', { selected: true }).getAttribute('aria-controls')).not.toBe(previousPanelId);
    const activePanelId = await page.getByRole('tab', { selected: true }).getAttribute('aria-controls');
    expect(activePanelId).toBeTruthy();
    const header = page.locator(`#${activePanelId} [data-testid^="block-metadata-header-"]`);
    await header.dblclick();

    await page.getByLabel('Block label').fill('bad\u200blabel');
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText(/Label cannot contain line breaks/)).toBeVisible();

    await page.getByLabel('Block label').fill('@reserved');
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText(/Label cannot start with @/)).toBeVisible();

    await page.getByLabel('Block label').fill('/reserved');
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText(/Label cannot start with \//)).toBeVisible();

    const validTitle = 'Intervals $[a,b]$';
    const validLabel = `Analysis/Intervals/$[a,b]|c$-${Date.now()}`;
    await page.getByLabel('Block title').fill(validTitle);
    await page.getByLabel('Block label').fill(validLabel);
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText('Tree transformation', { exact: true })).toBeVisible();
    await expect(page.getByText('Block label changes', { exact: false })).toBeVisible();
    await expect(page.getByText(validLabel, { exact: true }).first()).toBeVisible();
    const commitResponse = page.waitForResponse(response => response.url().endsWith('/api/relabel/commit') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Move and rename subtree/ }).click();
    expect((await commitResponse).ok()).toBeTruthy();
    await expect(page.getByText('Tree transformation complete')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    const savedBlockId = activePanelId!.replace('block-tab-panel-', '');
    await expect.poll(async () => {
        const response = await page.request.get(`/api/blocks/${savedBlockId}`);
        return await response.json();
    }).toMatchObject({ title: validTitle, label: validLabel });
});

test('edits active block metadata with F2 and a customized shortcut', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.press('F2');
    await expect(page.getByLabel('Block title')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Block title')).toBeHidden();

    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Keyboard Shortcuts' }).click();
    const shortcutInput = page.getByLabel('Edit active block metadata shortcut');
    await expect(shortcutInput).toHaveValue('f2');
    await shortcutInput.fill('mod+shift+e');
    await page.getByRole('button', { name: 'Save Settings' }).click();

    await page.keyboard.press('ControlOrMeta+Shift+E');
    await expect(page.getByLabel('Block title')).toBeFocused();
    await page.keyboard.press('Escape');

    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Keyboard Shortcuts' }).click();
    await page.getByLabel('Edit active block metadata shortcut').fill('f2');
    await page.getByRole('button', { name: 'Save Settings' }).click();
});

test('renders an embedded block whose label contains math bars and brackets', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `Norms/$||x[${suffix}]||$`;
    await page.request.post('/api/blocks', {
        data: { title: 'Special-character target', label: targetLabel, content: 'Target content' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Prototype-name target', label: '__proto__', content: 'Prototype target content' }
    });
    const sourceLabel = `special-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Special-character source',
            label: sourceLabel,
            content: `References: [[${targetLabel}]] and [[__proto__]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    await expect(page.getByText('Special-character target', { exact: true })).toBeVisible();
    await expect(page.getByText('Prototype-name target', { exact: true })).toBeVisible();
});

test('validates labels created from embed autocomplete', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '[[bad\u200blabel]]');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(page.getByText(/Create new block: "bad/)).toHaveCount(0);

    await replaceEditorText(page, editor, String.raw`[[\/reserved]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(page.getByText('Create new block: "/reserved"', { exact: true })).toHaveCount(0);

    const relativeLabel = `/relative-${Date.now()}`;
    await replaceEditorText(page, editor, `[[${relativeLabel}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(page.getByText(`Create new block: "${relativeLabel}"`, { exact: true })).toBeVisible();

    const suffix = Date.now();
    const validLabel = `New/$A[${suffix}]|B$`;
    await replaceEditorText(page, editor, `[[${validLabel}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    const createOption = page.getByText(`Create new block: "${validLabel}"`, { exact: true });
    await expect(createOption).toBeVisible();
    await createOption.click();

    await expect(editor).toBeFocused();

    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.some((block: { label: string }) => block.label === validLabel);
    }).toBe(true);
});

test('only opens label autocomplete inside a closed embed', async ({ page }) => {
    const editor = await openEditor(page);
    const label = `test:closed-autocomplete-${Date.now()}`;
    const createOption = page.getByText(`Create new block: "${label}"`, { exact: true });

    await replaceEditorText(page, editor, `[[${label}`);
    await page.keyboard.press('Control+Space');
    await expect(createOption).toBeHidden();

    await page.keyboard.insertText(']]');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(createOption).toBeVisible();
});

test('opens and preserves label autocomplete when entering a broken embed', async ({ page }) => {
    const editor = await openEditor(page);
    const suffix = Date.now();
    const label = `test:broken-entry-${suffix}`;
    const source = `before [[${label}]] after`;
    const completion = page.locator('.cm-tooltip-autocomplete');

    await replaceEditorText(page, editor, source);
    await page.getByText(`[[${label}]]`, { exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(page.getByText(`Create new block: "${label}"`, { exact: true })).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(completion).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(completion).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let index = 0; index < 'before '.length; index++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(completion).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+End');
    for (let index = 0; index < ' after'.length; index++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(completion).toBeVisible();

    await page.getByText(`Create new block: "${label}"`, { exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(completion).toBeHidden();
    await expect(page.getByText(/Enter\s+to toggle.*Cmd\/Ctrl \+ Enter.*for new tab/)).toBeVisible();
});

test('opens an existing embedded label in a tab next to the current tab with Mod-Enter', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:mod-enter-target-${suffix}`;
    const currentLabel = `test:mod-enter-current-${suffix}`;
    const trailingLabel = `test:mod-enter-trailing-${suffix}`;
    await page.request.post('/api/blocks', { data: { title: 'Mod Enter target', label: targetLabel, content: 'target' } });
    const currentBlock = await (await page.request.post('/api/blocks', { data: { title: 'Mod Enter current', label: currentLabel, content: `[[${targetLabel}]]` } })).json();
    await page.request.post('/api/blocks', { data: { title: 'Mod Enter trailing', label: trailingLabel, content: 'trailing' } });
    await openEditor(page);

    for (const label of [currentLabel, trailingLabel]) {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    }
    await page.getByRole('tab').filter({ hasText: 'Mod Enter current' }).click();
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ControlOrMeta+Enter');

    const tabs = page.getByRole('tab');
    const titles = await tabs.allTextContents();
    const currentIndex = titles.findIndex(title => title.includes('Mod Enter current'));
    expect(titles[currentIndex + 1]).toContain('Mod Enter target');
    await expect(tabs.filter({ hasText: 'Mod Enter target' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${currentBlock.id}`)).json()).content)
        .toBe(`[[${targetLabel}]]`);
});

test('keeps absolute autocomplete titles and derives relative titles from their leaf', async ({ page }) => {
    const suffix = Date.now();
    const parentLabel = `test:relative-title-parent-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Relative title parent', label: parentLabel, content: '' }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(parentLabel);
    await search.press('Enter');

    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    const relativeTarget = `/section/$A/B$-${suffix}`;
    await replaceEditorText(page, editor, `[[${relativeTarget}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await page.getByText(`Create new block: "${relativeTarget}"`, { exact: true }).click();

    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.find((block: { label: string }) => block.label === `${parentLabel}${relativeTarget}`);
    }).toMatchObject({ title: `$A/B$-${suffix}` });

    const absoluteTarget = `abc/def/ghi-${suffix}`;
    await replaceEditorText(page, editor, `[[${absoluteTarget}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await page.getByText(`Create new block: "${absoluteTarget}"`, { exact: true }).click();
    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.find((block: { label: string }) => block.label === absoluteTarget);
    }).toMatchObject({ title: absoluteTarget });
});

test('focuses a newly created root after creation from a nested editor', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:create-focus-child-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Create focus child', label: childLabel, content: 'child content' }
    });
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, `[[${childLabel}∨]]`);
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1)).toBeFocused();

    await page.getByLabel('Create new block').click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content')).toHaveCount(1);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
});

test('focuses the root editor when a block is selected through search', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:search-focus-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Search focus target', label: targetLabel, content: 'focus target content' }
    });
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(targetLabel);
    await search.press('Enter');

    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(targetLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
});

test('clicking the workspace background removes editor focus', async ({ page }) => {
    const editor = await openEditor(page);
    await expect(editor).toBeFocused();

    const background = page.locator('[role="tabpanel"][aria-hidden="false"]').filter({ visible: true });
    const box = await background.boundingBox();
    expect(box).not.toBeNull();
    await background.click({ position: { x: 4, y: box!.height - 4 } });

    await expect(editor).not.toBeFocused();
});

test('opens the nearest existing parent beside the current tab by button and custom shortcut', async ({ page }) => {
    const suffix = Date.now();
    const parentLabel = `test:parent-${suffix}`;
    const childLabel = `${parentLabel}/missing/child`;
    await page.request.post('/api/blocks', {
        data: { title: 'Nearest existing parent', label: parentLabel, content: 'parent content' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Deep hierarchy child', label: childLabel, content: 'child content' }
    });
    await openEditor(page);

    await page.getByRole('button', { name: /Search/ }).click();
    await page.getByPlaceholder('Search blocks or create new...').fill(childLabel);
    await page.getByPlaceholder('Search blocks or create new...').press('Enter');

    const childTab = page.getByRole('tab').filter({ hasText: 'Deep hierarchy child' });
    const parentTab = page.getByRole('tab').filter({ hasText: 'Nearest existing parent' });
    await page.getByRole('button', { name: `Go to nearest parent block ${parentLabel}` }).click();
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');

    const tabLabels = await page.getByRole('tab').allTextContents();
    expect(tabLabels.indexOf(await parentTab.textContent() || '')).toBe(tabLabels.indexOf(await childTab.textContent() || '') + 1);

    await childTab.click();
    await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');

    await childTab.click();
    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Keyboard Shortcuts' }).click();
    await page.getByLabel('Go to nearest parent block shortcut').fill('mod+shift+p');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.keyboard.press('ControlOrMeta+Shift+P');
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /Go to nearest parent block/ })).toHaveCount(0);
});

test('restores root focus when switching and closing tabs', async ({ page }) => {
    const suffix = Date.now();
    const firstLabel = `test:tab-focus-a-${suffix}`;
    const secondLabel = `test:tab-focus-b-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Tab focus A', label: firstLabel, content: 'first tab content' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Tab focus B', label: secondLabel, content: 'second tab content' }
    });
    await openEditor(page);

    const openThroughSearch = async (label: string) => {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
        await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    };
    await openThroughSearch(firstLabel);
    await openThroughSearch(secondLabel);

    const firstTab = page.locator('[draggable="true"]').filter({ hasText: 'Tab focus A' });
    await firstTab.click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(firstLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();

    await firstTab.locator('button').click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(secondLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
});

test('preserves recursive cursor and scroll state while switching mounted tabs', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:tab-restore-child-${suffix}`;
    const parentLabel = `test:tab-restore-parent-${suffix}`;
    const otherLabel = `test:tab-restore-other-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Restore child', label: childLabel, content: 'abcdef' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Restore parent',
            label: parentLabel,
            content: `${Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')}\n[[${childLabel}∨]]`
        }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Restore other', label: otherLabel, content: 'other tab' }
    });

    await openEditor(page);
    const openByLabel = async (label: string) => {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    };
    await openByLabel(parentLabel);
    const parentTab = page.getByRole('tab').filter({ hasText: 'Restore parent' });
    const parentPanelId = await parentTab.getAttribute('aria-controls');
    expect(parentPanelId).toBeTruthy();
    const parentPanel = page.locator(`#${parentPanelId}`);
    const parentScroller = parentPanel;
    await parentScroller.evaluate(element => { element.scrollTop = 420; });

    const parentEditor = parentPanel.locator('.cm-content').first();
    await parentEditor.focus();
    await page.keyboard.press('ControlOrMeta+End');
    await parentScroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(parentPanel.locator('[data-testid^="embedded-editor-host-"]')).toBeVisible();
    const childEditor = parentPanel.locator('.cm-content').nth(1);
    await childEditor.focus();
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const retainedScrollTop = await parentScroller.evaluate(element => element.scrollTop);

    await openByLabel(otherLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').filter({ visible: true }).first()).toBeFocused();

    await parentTab.click();
    await expect(childEditor).toBeFocused();
    await page.keyboard.insertText('X');
    await expect(childEditor).toContainText('abcXdef');
    expect(await parentScroller.evaluate(element => element.scrollTop)).toBe(retainedScrollTop);
});

test('supports accessible keyboard navigation and closing in the tab strip', async ({ page }) => {
    const suffix = Date.now();
    const firstLabel = `test:tab-keyboard-first-${suffix}`;
    const secondLabel = `test:tab-keyboard-second-${suffix}`;
    await page.request.post('/api/blocks', { data: { title: 'Keyboard tab first', label: firstLabel, content: 'first' } });
    await page.request.post('/api/blocks', { data: { title: 'Keyboard tab second', label: secondLabel, content: 'second' } });
    await openEditor(page);
    for (const label of [firstLabel, secondLabel]) {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    }

    const firstTab = page.getByRole('tab').filter({ hasText: 'Keyboard tab first' });
    const secondTab = page.getByRole('tab').filter({ hasText: 'Keyboard tab second' });
    // Wait for the editor autofocus scheduled by opening the second block;
    // otherwise it can race and steal focus back from the tab on slower VMs.
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    await secondTab.press('ArrowLeft');
    await expect(firstTab).toBeFocused();
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await firstTab.press('Enter');
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await firstTab.press('Delete');
    await expect(firstTab).toHaveCount(0);
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
});

test('handles desktop close, reopen, next, and previous note commands', async ({ page }) => {
    await page.addInitScript(() => {
        let commandListener: ((command: 'close-tab' | 'reopen-tab' | 'next-tab' | 'previous-tab') => void) | null = null;
        window.mathNotesDesktop = {
            updateShortcuts() {},
            chooseWorkspace: async () => false,
            getWorkspacePath: async () => '/tmp/math-notes-test-workspace',
            showWorkspaceInFolder: async () => true,
            onCommand(callback) {
                commandListener = callback;
                return () => { commandListener = null; };
            },
            onPrepareWorkspaceChange() { return () => {}; }
        };
        (window as any).__sendMathNotesCommand = (command: 'close-tab' | 'reopen-tab' | 'next-tab' | 'previous-tab') => commandListener?.(command);
    });

    const suffix = Date.now();
    const firstLabel = `test:desktop-tab-first-${suffix}`;
    const secondLabel = `test:desktop-tab-second-${suffix}`;
    await page.request.post('/api/blocks', { data: { title: 'Desktop tab first', label: firstLabel, content: 'first' } });
    await page.request.post('/api/blocks', { data: { title: 'Desktop tab second', label: secondLabel, content: 'second' } });
    await openEditor(page);
    for (const label of [firstLabel, secondLabel]) {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    }

    const firstTab = page.getByRole('tab').filter({ hasText: 'Desktop tab first' });
    const secondTab = page.getByRole('tab').filter({ hasText: 'Desktop tab second' });
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => (window as any).__sendMathNotesCommand('previous-tab'));
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => (window as any).__sendMathNotesCommand('next-tab'));
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => (window as any).__sendMathNotesCommand('close-tab'));
    await expect(secondTab).toHaveCount(0);
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => (window as any).__sendMathNotesCommand('reopen-tab'));
    await expect(secondTab).toHaveCount(1);
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
});

test('does not create a block when Down is pressed at the final root row', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'final root row');
    const before = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const after = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    expect(after).toHaveLength(before.length);
    await expect(editor).toBeFocused();
});

test('keeps touching embeds rendered and enters their raw syntax with horizontal arrows', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:keyboard-touch-target-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Keyboard touch target', label: targetLabel, content: 'Nested content' }
    });
    const editor = await openEditor(page);

    for (const syntax of [
        `[[${targetLabel}]]`,
        `[[${targetLabel}∨]]`,
        `[[@${targetLabel}]]`,
        `[[@${targetLabel}∨]]`
    ]) {
        await replaceEditorText(page, editor, syntax);

        await page.keyboard.press('ControlOrMeta+Home');
        const selectedEmbed = page.locator('[data-embed-keyboard-selected="true"]');
        await expect(selectedEmbed).toHaveCount(1);
        await expect(selectedEmbed).toHaveCSS('outline-style', 'dotted');
        await expect(selectedEmbed).toHaveCSS('outline-width', '1px');
        await expect(selectedEmbed).toHaveCSS('outline-color', 'rgba(96, 165, 250, 0.92)');
        await expect(selectedEmbed).toHaveCSS('border-radius', '0px');
        await expect(page.getByText('Keyboard touch target', { exact: true })).toBeVisible();

        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
        await expect(editor).toContainText(syntax);

        await page.keyboard.press('End');
        await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
        await expect(page.getByText('Keyboard touch target', { exact: true })).toBeVisible();

        await page.keyboard.press('ArrowLeft');
        await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
        await expect(editor).toContainText(syntax);
    }

    const surroundedStandout = `prefix [[@${targetLabel}]] suffix`;
    await replaceEditorText(page, editor, surroundedStandout);
    await page.keyboard.press('ControlOrMeta+Home');
    for (let index = 0; index < 'prefix '.length; index++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect(editor).toContainText(surroundedStandout);

    await replaceEditorText(page, editor, surroundedStandout);
    await page.keyboard.press('ControlOrMeta+End');
    for (let index = 0; index < ' suffix'.length; index++) await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect(editor).toContainText(surroundedStandout);
});

test('routes nested editor boundary arrows before default cursor movement', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:navigation-child-${suffix}`;
    const sourceLabel = `test:navigation-parent-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation child', label: targetLabel, content: 'Only child line' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation parent', label: sourceLabel, content: `[[${targetLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    const childEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);

    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('exits through nested final embeds to the parent editor boundary', async ({ page }) => {
    const suffix = Date.now();
    const innerLabel = `test:navigation-inner-${suffix}`;
    const outerLabel = `test:navigation-outer-${suffix}`;
    const rootLabel = `test:navigation-root-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Nested navigation inner', label: innerLabel, content: 'Inner final row' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Nested navigation outer', label: outerLabel, content: `[[${innerLabel}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Nested navigation root',
            label: rootLabel,
            content: `before\n[[${outerLabel}∨]]\nafter\nfinal`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();

    const outerEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    const innerEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(2);

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(outerEditor).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(innerEditor).toBeFocused();

    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(innerEditor).not.toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('enters the deepest final open embed from below and exits through the same visual path', async ({ page }) => {
    const suffix = Date.now();
    const level3Label = `test:navigation-up-level-3-${suffix}`;
    const level2Label = `test:navigation-up-level-2-${suffix}`;
    const level1Label = `test:navigation-up-level-1-${suffix}`;
    const rootLabel = `test:navigation-up-root-${suffix}`;

    await page.request.post('/api/blocks', {
        data: { title: 'Navigation level 3', label: level3Label, content: 'deep first\ndeep final' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation level 2', label: level2Label, content: `level two\n[[${level3Label}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation level 1', label: level1Label, content: `level one\n[[${level2Label}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Navigation upward root',
            label: rootLabel,
            content: `[[${level1Label}∨]]\nbelow`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    const deepestEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(3);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowUp');
    await expect(deepestEditor).toBeFocused();

    // Down from that deepest final row follows the inverse route and reaches
    // the root row below all three embeds without stopping on any title.
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(rootEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('moves one rendered row at a time around a closed standout title', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:closed-standout-target-${suffix}`;
    const sourceLabel = `test:closed-standout-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Closed standout target', label: targetLabel, content: 'Closed child content' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Closed standout source',
            label: sourceLabel,
            content: `above\n[[@${targetLabel}]]\nbelow`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();
    await expect(parentEditor).toBeFocused();

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await page.keyboard.insertText('DOWN-');
    await expect(parentEditor.locator('.cm-line').nth(2)).toContainText('DOWN-');

    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await page.keyboard.insertText('UP-');
    await expect(parentEditor.locator('.cm-line').first()).toContainText('UP-');
});

test('visits suffix and prefix rows surrounding a closed standout title', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:surrounded-standout-target-${suffix}`;
    const sourceLabel = `test:surrounded-standout-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Surrounded standout target', label: targetLabel, content: 'Child content' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Surrounded standout source',
            label: sourceLabel,
            content: `prefix [[@${targetLabel}]] suffix\nnextline`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();

    await expect(parentEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await page.keyboard.insertText('SUFFIX-');
    await expect(parentEditor.locator('.cm-line').first()).toContainText('SUFFIX-');
    await expect(parentEditor.locator('.cm-line').nth(1)).not.toContainText('SUFFIX-');

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('follows rendered rows through prefix text, inline bodies, and standout titles', async ({ page }) => {
    const suffix = Date.now();
    const inlineTargetLabel = `test:visual-inline-target-${suffix}`;
    const standoutTargetLabel = `test:visual-standout-target-${suffix}`;
    const inlineSourceLabel = `test:visual-inline-source-${suffix}`;
    const standoutSourceLabel = `test:visual-standout-source-${suffix}`;
    const wrappedChild = Array.from({ length: 45 }, (_, index) => `wrapped-${index}`).join(' ');

    await page.request.post('/api/blocks', {
        data: { title: 'Visual inline target', label: inlineTargetLabel, content: wrappedChild }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Visual standout target', label: standoutTargetLabel, content: 'Standout child row' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Visual inline source',
            label: inlineSourceLabel,
            content: `above\nprefix [[${inlineTargetLabel}∨]] suffix\nafter`
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Visual standout source',
            label: standoutSourceLabel,
            content: `prefix [[@${standoutTargetLabel}∨]] suffix\nafter`
        }
    });

    await openEditor(page);
    const openByLabel = async (label: string) => {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
        await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    };

    await openByLabel(inlineSourceLabel);
    let parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    let childEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    await page.keyboard.press('ControlOrMeta+Home');

    // The next source line starts with ordinary text, so the first Down stays
    // in the parent instead of jumping over that text into the open child.
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(childEditor).not.toBeFocused();

    // The inline title shares that visual row; its body is the next row.
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();

    // A soft-wrapped first source line still has more visual rows, so Down must
    // remain inside the child rather than treating it as the child boundary.
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();

    // Up from the first child row returns to the visible title row. Entering
    // again and leaving the final row proceeds into the visible parent suffix.
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);

    await openByLabel(standoutSourceLabel);
    parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    childEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    await page.keyboard.press('ControlOrMeta+Home');

    // A standout title creates its own rendered row and is therefore visited
    // before entering the child body.
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();
});

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
        const saveRequest = page.waitForRequest(request => {
            if (request.method() !== 'PUT' || !request.url().includes('/api/blocks/')) return false;
            return request.postDataJSON()?.content === expected;
        });
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

test('loads note bodies on demand while keeping the block index metadata-only', async ({ page }) => {
    const runtime = await page.request.get('/api/runtime');
    expect(await runtime.json()).toMatchObject({ testMode: true, desktop: false });

    const metadataResponse = await page.request.get('/api/blocks?metaOnly=true');
    expect(metadataResponse.ok()).toBeTruthy();
    const metadata = await metadataResponse.json();
    expect(metadata.length).toBeGreaterThan(0);
    expect(metadata.every((block: Record<string, unknown>) => !('content' in block))).toBeTruthy();
    expect(metadata.every((block: Record<string, unknown>) => typeof block.hasContent === 'boolean')).toBeTruthy();

    const contentResponse = await page.request.get(`/api/blocks/${metadata[0].id}`);
    expect(contentResponse.ok()).toBeTruthy();
    expect(typeof (await contentResponse.json()).content).toBe('string');
});

test('preserves reference cascades when lazily loaded block labels change', async ({ page }) => {
    const suffix = Date.now();
    const originalLabel = `test:lazy-target-${suffix}`;
    const targetBlock = await (await page.request.post('/api/blocks', {
        data: { title: 'Lazy target', label: originalLabel, content: '$x$' }
    })).json();
    const source = await (await page.request.post('/api/blocks', {
        data: { title: 'Lazy source', label: `test:lazy-source-${suffix}`, content: `before [[${originalLabel}]] after` }
    })).json();
    const renamedLabel = `test:lazy-renamed-${suffix}`;
    const preview = await (await page.request.post('/api/relabel/preview', {
        data: { oldPrefix: originalLabel, newPrefix: renamedLabel }
    })).json();
    const response = await page.request.post('/api/relabel/commit', {
        data: { oldPrefix: originalLabel, newPrefix: renamedLabel, revision: preview.revision }
    });
    expect(response.ok()).toBeTruthy();

    const sourceAfterRename = await (await page.request.get(`/api/blocks/${source.id}`)).json();
    expect(sourceAfterRename.content).toContain(`[[${renamedLabel}]]`);
    expect(sourceAfterRename.content).not.toContain(`[[${originalLabel}]]`);
});

test('preserves parsed math around an incrementally edited line', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'before $a^2$\nchange here\nafter $\\frac{b}{c}$');

    await editor.locator('.cm-line').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' safely');
    await page.getByLabel('Open settings').click();

    await expect(page.locator('.cm-math-inline .katex')).toHaveCount(2);
    await expect(editor).toContainText('change here safely');
    await page.keyboard.press('Escape');
});

test('keeps adjacent dollars as empty inline math instead of block math', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'top $a$\ninside $$ line\nbottom $b$');

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.insertText(' safely');
    await page.getByLabel('Open settings').click();

    await expect(page.locator('.cm-math-block')).toHaveCount(0);
    await expect(page.locator('.cm-math-inline .katex')).toHaveCount(2);
    await expect(page.locator('.cm-math-editing')).toContainText('$$');
    await page.keyboard.press('Escape');
});

test('renders and edits display math without crashing the editor', async ({ page }) => {
    const editorErrors: string[] = [];
    page.on('pageerror', error => {
        if (/Block decorations|No tile at position|coordsAt/.test(error.message)) {
            editorErrors.push(error.message);
        }
    });
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'Before display math\n\\[\n\\int_0^1 t^2 \\,dt\n\\]\nAfter display math');

    // Blurring replaces the source range with a block KaTeX widget.
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-block .katex')).toBeVisible();
    await expect(editor).toContainText('Before display math');
    await expect(editor).toContainText('After display math');
    await page.keyboard.press('Escape');

    // Activating it restores the source and keeps the block preview visible.
    await page.locator('.cm-math-block').click();
    await expect(editor).toContainText('\\int_0^1 t^2');
    await expect(page.locator('.cm-math-block .katex')).toBeVisible();
    expect(editorErrors).toEqual([]);
});

test('indents selected display-math lines with Tab and outdents with Shift+Tab', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '\\[\nfirst\nsecond\n\\]');

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Tab');

    await expect.poll(() => editor.evaluate(element => element.textContent)).toContain('  first  second');

    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => editor.evaluate(element => element.textContent)).toContain('firstsecond');
});

test('renders image previews as their lines enter the viewport', async ({ page }) => {
    test.setTimeout(60_000);
    const editor = await openEditor(page);
    const image = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="1"/>';
    const content = Array.from({ length: 180 }, (_, index) => `${index} ${index === 0 || index === 179 ? image : 'plain text'}`).join('\n');
    await replaceEditorText(page, editor, content);

    await page.keyboard.press('ControlOrMeta+Home');
    await expect(page.locator('.cm-image-widget')).toBeVisible();
    await page.locator('.cm-scroller').evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('.cm-image-widget')).toBeVisible();
});

test('stores portable image paths and renders portable and legacy asset references', async ({ page }) => {
    const assetName = `test-image-${Date.now()}.gif`;
    const upload = await page.request.post('/api/assets', {
        data: {
            filePath: `assets/${assetName}`,
            content: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        }
    });
    expect(upload.ok()).toBeTruthy();
    expect(await upload.json()).toMatchObject({ url: `assets/${assetName}` });

    const editor = await openEditor(page);
    await replaceEditorText(page, editor, [
        `<img src="assets/${assetName}" width="1"/>`,
        `<img src="/api/assets/${assetName}" width="1"/>`,
        'after images'
    ].join('\n'));
    await editor.evaluate(element => (element as HTMLElement).blur());

    const images = page.locator('.cm-image-widget img');
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll(elements => elements.map(element => (element as HTMLImageElement).naturalWidth)))
        .toEqual([1, 1]);
});

test('renders workspace assets in the web read-only viewer', async ({ page }) => {
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Read-Only Viewer' })).toBeVisible();

    await page.locator('input[type="file"][webkitdirectory]').setInputFiles(
        path.resolve('tests/fixtures/viewer-workspace')
    );

    await expect(page.getByText('Viewer image test', { exact: true }).first()).toBeVisible();
    const images = page.locator('.cm-image-widget img');
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll(elements => elements.map(element => (element as HTMLImageElement).naturalWidth)))
        .toEqual([2, 2]);
});

test('creates an open embedded editor only when it approaches the viewport', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:lazy-editor-target-${suffix}`;
    const sourceLabel = `test:lazy-editor-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Lazy embedded target', label: targetLabel, content: 'Nested content with $x^2$.' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Lazy embedded source',
            label: sourceLabel,
            content: `${Array.from({ length: 220 }, (_, index) => `line ${index}`).join('\n')}\n[[${targetLabel}∨]]\nend`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toContainText('line 0');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content')).toHaveCount(1);

    await page.locator('[role="tabpanel"][aria-hidden="false"]').evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="embedded-editor-host-"]')).toBeVisible();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content')).toHaveCount(2);
    await expect(page.locator('.cm-math-inline .katex')).toBeVisible();
});

test('loads the graph feature only when it is opened', async ({ page }) => {
    await openEditor(page);
    await expect(page.getByRole('heading', { name: 'Graph View' })).toBeHidden();
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
    await expect(page.getByText(/File → Open Workspace/)).toBeVisible();
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
    await page.getByRole('tab', { name: 'Math Visual' }).click();
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

    await page.getByRole('tab', { name: 'Math Visual' }).click();
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
    const saved = await request.post('/api/workspace/session', { data: { openTabs: ids, activeTab: ids[1], persistForTest: true } });
    expect(saved.ok()).toBeTruthy();

    await openEditor(page);
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('aria-controls', `block-tab-panel-${ids[1]}`);
});
