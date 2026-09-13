import { expect, test, type APIRequestContext } from 'playwright/test';
import { encodeEmbeddedLabel } from '../src/lib/embedded-link-syntax';

type TestBlock = { id: string; title: string; label: string; content: string };

const unique = (name: string) => `relabel-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createBlock(request: APIRequestContext, label: string, content = '', title = label): Promise<TestBlock> {
    const response = await request.post('/api/blocks', { data: { title, label, content } });
    if (!response.ok()) throw new Error(`Creating test block failed: ${await response.text()}`);
    return await response.json();
}

async function preview(request: APIRequestContext, oldPrefix: string, newPrefix: string) {
    const response = await request.post('/api/relabel/preview', { data: { oldPrefix, newPrefix } });
    if (!response.ok()) throw new Error(`Previewing relabel failed: ${await response.text()}`);
    return await response.json();
}

async function commit(request: APIRequestContext, plan: any) {
    const response = await request.post('/api/relabel/commit', {
        data: { oldPrefix: plan.oldPrefix, newPrefix: plan.newPrefix, revision: plan.revision }
    });
    if (!response.ok()) throw new Error(`Committing relabel failed: ${await response.text()}`);
    return await response.json();
}

async function readBlock(request: APIRequestContext, id: string): Promise<TestBlock> {
    const response = await request.get(`/api/blocks/${id}`);
    expect(response.ok()).toBeTruthy();
    return await response.json();
}

test.describe('safe relabel structural transformations', () => {
    const cases = [
        { name: 'rename node', type: 'rename-node', oldTail: 'Area/Old', newTail: 'Area/New' },
        { name: 'insert parent', type: 'insert-parent', oldTail: 'Area/Leaf', newTail: 'Area/Inserted/Leaf' },
        { name: 'remove parent', type: 'remove-parent', oldTail: 'Area/Removed/Leaf', newTail: 'Area/Leaf' },
        { name: 'move subtree', type: 'move-subtree', oldTail: 'Area/Leaf', newTail: 'Elsewhere/Leaf' },
        { name: 'move and rename subtree', type: 'move-and-rename', oldTail: 'Area/Old', newTail: 'Elsewhere/New' }
    ] as const;

    for (const scenario of cases) {
        test(`${scenario.name} updates the root, descendants, and incoming links`, async ({ request }) => {
            const namespace = unique(scenario.type);
            const oldPrefix = `${namespace}/${scenario.oldTail}`;
            const newPrefix = `${namespace}/${scenario.newTail}`;
            const root = await createBlock(request, oldPrefix, 'relative [[/Child]]', `${scenario.name} root`);
            const child = await createBlock(request, `${oldPrefix}/Child`, 'child body', `${scenario.name} child`);
            const source = await createBlock(request, `${namespace}/Index`, `before [[${oldPrefix}/Child]] after`, `${scenario.name} index`);

            const plan = await preview(request, oldPrefix, newPrefix);
            expect(plan.changeType).toBe(scenario.type);
            expect(plan.conflicts).toEqual([]);
            expect(plan.blockChanges).toHaveLength(2);
            expect(plan.referenceImpacts).toEqual(expect.arrayContaining([
                expect.objectContaining({ oldText: '[[/Child]]', newText: '[[/Child]]', changed: false }),
                expect.objectContaining({ oldTarget: `${oldPrefix}/Child`, newTarget: `${newPrefix}/Child`, changed: true })
            ]));

            await commit(request, plan);
            expect(await readBlock(request, root.id)).toMatchObject({ label: newPrefix, content: 'relative [[/Child]]' });
            expect(await readBlock(request, child.id)).toMatchObject({ label: `${newPrefix}/Child` });
            expect((await readBlock(request, source.id)).content).toBe(`before [[${newPrefix}/Child]] after`);
        });
    }

    test('no-op is classified without writing any blocks', async ({ request }) => {
        const label = unique('no-op');
        await createBlock(request, label);
        const plan = await preview(request, label, label);
        expect(plan).toMatchObject({ changeType: 'no-op', conflicts: [] });
        const result = await commit(request, plan);
        expect(result.updatedBlocks).toEqual([]);
    });

    test('transforms a virtual node that has descendants but no block of its own', async ({ request }) => {
        const namespace = unique('virtual');
        const oldPrefix = `${namespace}/MissingParent`;
        const newPrefix = `${namespace}/RenamedVirtualParent`;
        const leaf = await createBlock(request, `${oldPrefix}/Leaf`);
        const deep = await createBlock(request, `${oldPrefix}/Leaf/Deep`);

        const plan = await preview(request, oldPrefix, newPrefix);
        expect(plan.conflicts).toEqual([]);
        expect(plan.blockChanges.map((change: any) => change.oldLabel)).toEqual([
            `${oldPrefix}/Leaf`,
            `${oldPrefix}/Leaf/Deep`
        ]);
        await commit(request, plan);
        expect((await readBlock(request, leaf.id)).label).toBe(`${newPrefix}/Leaf`);
        expect((await readBlock(request, deep.id)).label).toBe(`${newPrefix}/Leaf/Deep`);
    });
});

test.describe('safe relabel reference preservation', () => {
    test('preserves all embed decorations and rewrites repeated absolute links', async ({ request }) => {
        const namespace = unique('syntax');
        const oldPrefix = `${namespace}/Old`;
        const newPrefix = `${namespace}/New`;
        const target = await createBlock(request, oldPrefix);
        const sourceContent = [
            `plain [[${oldPrefix}]]`,
            `alias [[${oldPrefix}||Visible name]]`,
            `open [[${oldPrefix}∨]]`,
            `standout [[@${oldPrefix}]]`,
            `combined [[@${oldPrefix}||Visible name∨]]`,
            `repeated [[${oldPrefix}]] then [[${oldPrefix}]]`
        ].join('\n');
        const source = await createBlock(request, `${namespace}/Source`, sourceContent);

        await commit(request, await preview(request, oldPrefix, newPrefix));
        expect((await readBlock(request, target.id)).label).toBe(newPrefix);
        expect((await readBlock(request, source.id)).content).toBe(sourceContent.split(oldPrefix).join(newPrefix));
    });

    test('rewrites unresolved forward links and reports them as warnings', async ({ request }) => {
        const namespace = unique('unresolved');
        const oldPrefix = `${namespace}/Old`;
        const newPrefix = `${namespace}/New`;
        await createBlock(request, oldPrefix);
        const source = await createBlock(request, `${namespace}/Source`, `future [[${oldPrefix}/NotCreated]]`);

        const plan = await preview(request, oldPrefix, newPrefix);
        expect(plan.warnings.join(' ')).toContain('do not currently have blocks');
        expect(plan.referenceImpacts).toContainEqual(expect.objectContaining({
            oldTarget: `${oldPrefix}/NotCreated`,
            newTarget: `${newPrefix}/NotCreated`,
            targetExists: false,
            changed: true
        }));
        await commit(request, plan);
        expect((await readBlock(request, source.id)).content).toBe(`future [[${newPrefix}/NotCreated]]`);
    });

    test('does not rewrite unrelated absolute links inside a moved block', async ({ request }) => {
        const namespace = unique('unrelated');
        const oldPrefix = `${namespace}/Old`;
        const newPrefix = `${namespace}/New`;
        const external = await createBlock(request, `${namespace}/External`);
        const moving = await createBlock(request, oldPrefix, `outside [[${external.label}]]`);

        const plan = await preview(request, oldPrefix, newPrefix);
        expect(plan.referenceImpacts).toEqual([]);
        await commit(request, plan);
        expect(await readBlock(request, moving.id)).toMatchObject({ label: newPrefix, content: `outside [[${external.label}]]` });
    });

    test('uses parsed path segments when a math segment contains a slash', async ({ request }) => {
        const namespace = unique('math-path');
        const oldPrefix = `${namespace}/$a/b$/Node`;
        const newPrefix = `${namespace}/$a/b$/Renamed`;
        const encodedOld = encodeEmbeddedLabel(oldPrefix);
        const encodedNew = encodeEmbeddedLabel(newPrefix);
        const target = await createBlock(request, oldPrefix);
        const child = await createBlock(request, `${oldPrefix}/Child`);
        const source = await createBlock(request, `${namespace}/Source`, `see [[${encodedOld}/Child]]`);

        const plan = await preview(request, oldPrefix, newPrefix);
        expect(plan.changeType).toBe('rename-node');
        expect(plan.blockChanges).toHaveLength(2);
        await commit(request, plan);
        expect((await readBlock(request, target.id)).label).toBe(newPrefix);
        expect((await readBlock(request, child.id)).label).toBe(`${newPrefix}/Child`);
        expect((await readBlock(request, source.id)).content).toBe(`see [[${encodedNew}/Child]]`);
    });

    test('keeps prefix-like siblings unchanged', async ({ request }) => {
        const namespace = unique('boundary');
        const oldPrefix = `${namespace}/Node`;
        const newPrefix = `${namespace}/Renamed`;
        const moving = await createBlock(request, oldPrefix);
        const sibling = await createBlock(request, `${namespace}/NodeExtra`);
        const source = await createBlock(request, `${namespace}/Source`, `[[${oldPrefix}]] [[${namespace}/NodeExtra]]`);

        await commit(request, await preview(request, oldPrefix, newPrefix));
        expect((await readBlock(request, moving.id)).label).toBe(newPrefix);
        expect((await readBlock(request, sibling.id)).label).toBe(`${namespace}/NodeExtra`);
        expect((await readBlock(request, source.id)).content).toBe(`[[${newPrefix}]] [[${namespace}/NodeExtra]]`);
    });

    test('preserves escaping, aliases, and math syntax in special-character links', async ({ request }) => {
        const namespace = unique('escaped');
        const oldPrefix = `${namespace}/Notes [draft] || old∨`;
        const newPrefix = `${namespace}/Notes [final] || new∨`;
        const encodedOld = encodeEmbeddedLabel(oldPrefix);
        const encodedNew = encodeEmbeddedLabel(newPrefix);
        await createBlock(request, oldPrefix);
        const source = await createBlock(
            request,
            `${namespace}/Source`,
            `see [[@${encodedOld}||Alias $||x||$∨]]`
        );

        await commit(request, await preview(request, oldPrefix, newPrefix));
        expect((await readBlock(request, source.id)).content)
            .toBe(`see [[@${encodedNew}||Alias $||x||$∨]]`);
    });

    test('preserves self references and cycles after the subtree changes', async ({ request }) => {
        const namespace = unique('cycles');
        const oldPrefix = `${namespace}/Old`;
        const newPrefix = `${namespace}/New`;
        const root = await createBlock(request, oldPrefix, `self [[${oldPrefix}]] child [[/Child]]`);
        const child = await createBlock(request, `${oldPrefix}/Child`, `back [[${oldPrefix}]]`);

        await commit(request, await preview(request, oldPrefix, newPrefix));
        expect((await readBlock(request, root.id)).content).toBe(`self [[${newPrefix}]] child [[/Child]]`);
        expect((await readBlock(request, child.id)).content).toBe(`back [[${newPrefix}]]`);
    });
});

test.describe('safe relabel rejection cases', () => {
    test('reports root and descendant destination collisions', async ({ request }) => {
        const namespace = unique('collisions');
        const rootOld = `${namespace}/OldRoot`;
        const rootDestination = `${namespace}/OccupiedRoot`;
        await createBlock(request, rootOld);
        await createBlock(request, rootDestination, '', 'Existing root destination');
        const rootPlan = await preview(request, rootOld, rootDestination);
        expect(rootPlan.conflicts.join(' ')).toContain('already occupied');

        const subtreeOld = `${namespace}/OldSubtree`;
        const subtreeDestination = `${namespace}/NewSubtree`;
        await createBlock(request, subtreeOld);
        await createBlock(request, `${subtreeOld}/Child`);
        await createBlock(request, `${subtreeDestination}/Child`, '', 'Existing child destination');
        const childPlan = await preview(request, subtreeOld, subtreeDestination);
        expect(childPlan.conflicts.join(' ')).toContain(`${subtreeDestination}/Child`);
        const rejected = await request.post('/api/relabel/commit', {
            data: { oldPrefix: childPlan.oldPrefix, newPrefix: childPlan.newPrefix, revision: childPlan.revision }
        });
        expect(rejected.status()).toBe(409);
    });

    test('rejects moving a subtree into itself', async ({ request }) => {
        const oldPrefix = unique('self');
        await createBlock(request, oldPrefix);
        const plan = await preview(request, oldPrefix, `${oldPrefix}/Nested`);
        expect(plan.conflicts.join(' ')).toContain('inside its own subtree');
    });

    test('rejects nonexistent sources and invalid destinations', async ({ request }) => {
        const namespace = unique('invalid');
        const missing = await preview(request, `${namespace}/Missing`, `${namespace}/New`);
        expect(missing.conflicts.join(' ')).toContain('No block or descendant exists');

        const source = `${namespace}/Source`;
        await createBlock(request, source);
        for (const invalid of ['', '@reserved', '/reserved', `bad\nlabel`]) {
            const plan = await preview(request, source, invalid);
            expect(plan.conflicts.length).toBeGreaterThan(0);
        }
    });

    test('rejects a valid root destination when a descendant would exceed the label limit', async ({ request }) => {
        const namespace = unique('descendant-limit');
        const oldPrefix = `${namespace}/A`;
        const longLeaf = 'x'.repeat(512 - oldPrefix.length - 1);
        await createBlock(request, `${oldPrefix}/${longLeaf}`);
        const newPrefix = `${namespace}/${'longer-than-a'}`;
        const plan = await preview(request, oldPrefix, newPrefix);
        expect(plan.conflicts.join(' ')).toContain('cannot exceed 512 characters');
    });

    test('accepts semantically unchanged previews but rejects changed plans and direct label PUTs', async ({ request }) => {
        const oldPrefix = unique('stale');
        const newPrefix = unique('fresh');
        const block = await createBlock(request, oldPrefix);
        const plan = await preview(request, oldPrefix, newPrefix);

        const bypass = await request.put(`/api/blocks/${block.id}`, { data: { ...block, label: newPrefix } });
        expect(bypass.status()).toBe(409);
        const ordinaryEdit = await request.put(`/api/blocks/${block.id}`, { data: { ...block, title: 'Changed after preview' } });
        expect(ordinaryEdit.ok()).toBeTruthy();
        const harmlessRevisionChange = await request.post('/api/relabel/commit', {
            data: { oldPrefix, newPrefix, revision: plan.revision, signature: plan.signature }
        });
        expect(harmlessRevisionChange.ok()).toBeTruthy();

        const relevantOld = unique('relevant-stale');
        const relevantNew = unique('relevant-fresh');
        const relevantBlock = await createBlock(request, relevantOld);
        const relevantPlan = await preview(request, relevantOld, relevantNew);
        const contentUpdate = await request.put(`/api/blocks/${relevantBlock.id}`, {
            data: { ...relevantBlock, content: `new affected link [[${relevantOld}]]` }
        });
        expect(contentUpdate.ok()).toBeTruthy();
        const stale = await request.post('/api/relabel/commit', {
            data: {
                oldPrefix: relevantOld,
                newPrefix: relevantNew,
                revision: relevantPlan.revision,
                signature: relevantPlan.signature
            }
        });
        expect(stale.status()).toBe(409);
        expect((await stale.json()).error).toContain('workspace changed');
    });
});

test('an unchanged editor blur does not stale the first UI confirmation', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.waitFor({ state: 'visible' });
    await editor.click();
    await page.waitForTimeout(650);

    let blockPuts = 0;
    page.on('request', request => {
        if (request.method() === 'PUT' && request.url().includes('/api/blocks/')) blockPuts++;
    });
    const header = page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]');
    await header.dblclick();
    await page.getByLabel('Block label').fill(unique('ui-first-confirm'));
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText('Tree transformation', { exact: true })).toBeVisible();
    await page.waitForTimeout(650);
    expect(blockPuts).toBe(0);

    await page.getByRole('button', { name: /Rename node|Move and rename subtree/ }).click();
    await expect(page.getByText('Tree transformation complete')).toBeVisible();
    await expect(page.getByText(/workspace changed while the preview was open/i)).toHaveCount(0);
});

test('Enter confirms header editing without inserting a content newline or staling the preview', async ({ page, request }) => {
    const oldLabel = unique('enter-header-old');
    const newLabel = unique('enter-header-new');
    const content = 'Content must remain byte-for-byte unchanged.';
    const block = await createBlock(request, oldLabel, content, 'Enter header regression');

    await page.goto('/');
    await page.getByRole('button', { name: /Search/ }).first().click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(oldLabel);
    await page.getByText('Enter header regression', { exact: true }).click();

    const header = page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]');
    await header.dblclick();
    const labelInput = page.getByLabel('Block label');
    await labelInput.fill(newLabel);
    await labelInput.press('Enter');
    await expect(page.getByText('Tree transformation', { exact: true })).toBeVisible();
    await page.waitForTimeout(650);
    expect((await readBlock(request, block.id)).content).toBe(content);

    await page.getByRole('button', { name: /Rename node|Move and rename subtree/ }).click();
    await expect(page.getByText('Tree transformation complete')).toBeVisible();
    await expect(page.getByText(/workspace changed while the preview was open/i)).toHaveCount(0);
    expect((await readBlock(request, block.id)).content).toBe(content);
});

test('safe relabel preview shows source and destination parent context', async ({ page, request }) => {
    const namespace = unique('parent-context');
    const oldParent = `${namespace}/Mathematics/Subjects/Topology`;
    const newParent = `${namespace}/Mathematics/Subjects/Geometry`;
    const oldPrefix = `${oldParent}/Manifolds`;
    const newPrefix = `${newParent}/Manifolds`;
    await createBlock(request, oldParent, '', 'Source parent');
    await createBlock(request, newParent, '', 'Destination parent');
    await createBlock(request, oldPrefix, '', 'Moving root');
    await createBlock(request, `${oldPrefix}/Smooth`, '', 'Moving child');
    await createBlock(request, `${newParent}/Curves`, '', 'Destination sibling');

    await page.goto('/');
    await page.getByRole('button', { name: /Search/ }).first().click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(oldPrefix);
    await page.getByText('Moving root', { exact: true }).click();

    const header = page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]');
    await header.dblclick();
    await page.getByLabel('Block label').fill(newPrefix);
    await page.getByLabel('Save block metadata').click();

    const before = page.getByTestId('safe-relabel-before-tree');
    const after = page.getByTestId('safe-relabel-after-tree');
    await expect(before.getByLabel(oldParent, { exact: true })).toBeVisible();
    await expect(before).toContainText('Existing parent');
    await expect(before).toContainText('Smooth');
    await expect(after.getByLabel(newParent, { exact: true })).toBeVisible();
    await expect(after).toContainText('Existing parent');
    await expect(after).toContainText('Curves');
    await expect(after.getByText('Nearby existing siblings')).toBeVisible();
    const collapsedBreadcrumb = before.getByRole('button', { name: `Show complete path ${oldPrefix}` });
    await expect(collapsedBreadcrumb).toBeVisible();
    await collapsedBreadcrumb.click();
    await expect(before.getByRole('button', { name: 'Collapse' })).toBeVisible();

    await page.getByText('Show complete paths', { exact: true }).click();
    const completePaths = page.getByTestId('safe-relabel-complete-paths');
    const exactBefore = completePaths.getByText(oldPrefix, { exact: true });
    const exactAfter = completePaths.getByText(newPrefix, { exact: true });
    await expect(exactBefore).toBeVisible();
    await expect(exactAfter).toBeVisible();
    await expect(page.getByRole('button', { name: `Copy full path ${newPrefix}` })).toBeVisible();
});
