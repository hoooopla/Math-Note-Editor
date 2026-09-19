import { test, expect, type Page } from 'playwright/test';
import { createBlocksViewFixture } from '../src/lib/blocks-view-fixture';
import { buildBlockMapModel } from '../src/lib/block-map';

async function start(page: Page, size = 360) {
    await page.request.post('/api/test/reset');
    const seeded = await page.request.post('/api/test/blocks-view-fixture', { data: { size } });
    expect(await seeded.json()).toMatchObject({ count: size, testMode: true });
    await page.goto('/');
    await page.getByLabel('Close workspace issues').click();
    await page.getByLabel('Open blocks view').click();
    await expect(page.getByRole('heading', { name: 'Blocks View' })).toBeVisible();
}
async function find(page: Page, id: string, query: string) {
    await page.getByLabel('Search blocks view').fill(query);
    await page.getByTestId(`block-map-node-bv-${id}`).click();
}
async function openFilters(page: Page) {
    const filters = page.locator('.bv-filter-menu');
    if (await filters.getAttribute('open') === null) await filters.locator('summary').click();
}
test('fixture topology covers missing ancestors, conflicts, isolation, relative links, cycles and hubs', () => {
    const fixture = createBlocksViewFixture();
    expect(fixture).toHaveLength(360);
    const model = buildBlockMapModel(fixture);
    const n = model.nodeById;
    expect(n['bv-uniform'].parentId).toBe('bv-analysis');
    expect(n['bv-foundation'].incomingIds.length).toBe(222);
    expect(n['bv-repeat'].outgoingIds).toEqual(['bv-foundation']);
    expect(n['bv-self'].outgoingIds).toEqual(['bv-self']);
    expect(n['bv-cycle-c'].outgoingIds).toEqual(['bv-cycle-a']);
    expect(n['bv-pair-a'].incomingIds).toEqual(['bv-pair-b']);
    expect(n['bv-relative'].outgoingIds).toEqual(['bv-relative-child']);
    expect(n['bv-broken'].brokenTargets).toEqual(['atlas/missing/lemma']);
    expect(n['bv-ambiguous'].ambiguousTargets).toEqual(['atlas/conflict']);
    expect(n['bv-ambiguous'].brokenTargets).toEqual([]);
    expect(n['bv-duplicate-a'].health).toContain('duplicate');
    expect(n['bv-empty'].health).toContain('empty');
    expect(n['bv-isolated'].health).toContain('orphan');
    expect(n['bv-same-name'].health).not.toContain('duplicate');
});
test('search retains virtual and real ancestors; select differs from open', async ({ page }) => {
    await start(page);
    await find(page, 'uniform', 'Uniform convergence');
    await expect(page.getByTestId('block-map-node-bv-analysis')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Namespace atlas/analysis/sequences', exact: true })).toBeVisible();
    const inspector = page.getByLabel('Block inspector');
    await expect(inspector.locator('.bv-graph-selected .katex')).toHaveCount(1);
    await expect(inspector.locator('.bv-graph-parent')).toContainText('Analysis');
    await openFilters(page);
    await page.getByText('Show matches only').click();
    await expect(page.getByTestId('namespace-row')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.locator('.bv-filter-menu summary').click();
    await page.getByLabel('Relationship map').locator('.bv-graph-selected').dblclick();
    await expect(page.getByRole('heading', { name: 'Blocks View' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Uniform convergence/ })).toBeVisible();
});
test('all diagnostic filters and empty results retain selection', async ({ page }) => {
    await start(page);
    await find(page, 'broken', 'unresolved reference');
    await expect(page.getByTestId('block-map-missing-target')).toContainText('atlas/missing/lemma');
    await page.getByLabel('Search blocks view').fill('');
    await openFilters(page);
    await page.getByLabel('Filter by state').selectOption('duplicate');
    await expect(page.getByTestId('block-map-node-bv-duplicate-a')).toBeVisible();
    await expect(page.getByTestId('block-map-node-bv-duplicate-b')).toBeVisible();
    await expect(page.getByText('Selected note is outside the current filters.')).toBeVisible();
    await page.getByLabel('Filter by state').selectOption('empty');
    await expect(page.getByTestId('block-map-node-bv-empty')).toBeVisible();
    await page.getByLabel('Filter by state').selectOption('fully-isolated');
    await page.getByLabel('Search blocks view').fill('isolated-example');
    await expect(page.getByTestId('block-map-node-bv-isolated')).toBeVisible();
    await page.getByLabel('Search blocks view').fill('no-such-note-xyz');
    await expect(page.getByText('No matching notes.')).toBeVisible();
    await expect(page.getByLabel('Relationship map').locator('.bv-graph-selected')).toBeVisible();
});
test('relationship map aggregates repeated mentions, ambiguity, hubs and self references', async ({ page }) => {
    await start(page);
    await find(page, 'repeat', 'Five mentions');
    await expect(page.getByText('×5 mentions')).toBeVisible();
    await expect(page.getByLabel('Relationship map').locator('.bv-graph-selected')).toContainText('Five mentions');
    await page.getByLabel('Relationship map').locator('.bv-graph-outgoing').dblclick();
    await expect(page.getByLabel('Relationship map').locator('.bv-graph-selected')).toContainText('Completeness');
    await expect(page.getByLabel('Relationship map').locator('.bv-graph-incoming')).toHaveCount(222);
    await find(page, 'ambiguous', 'ambiguous reference');
    await expect(page.getByText('⚠ Ambiguous target · multiple notes use this label')).toBeVisible();
    await find(page, 'self', 'atlas/logic/self');
    await expect(page.getByText('↻ Self-reference')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(0);
});
test('relationship-map nodes support keyboard selection and opening', async ({ page }) => {
    await start(page);
    await find(page, 'repeat', 'Five mentions');
    const map = page.getByLabel('Relationship map');
    await map.locator('.bv-graph-outgoing').focus();
    await page.keyboard.press('Enter');
    await expect(map.locator('.bv-graph-selected')).toContainText('Completeness');
    await map.locator('.bv-graph-selected').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Blocks View' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Completeness/ })).toBeVisible();
});
test('structure uses a bounded directional relationship map and compact filters', async ({ page }) => {
    await start(page);
    await find(page, 'uniform', 'Uniform convergence');
    const map = page.getByLabel('Relationship map');
    await expect(map).toBeVisible();
    await expect(map.locator('.bv-graph-parent')).toContainText('Analysis');
    await expect(map.locator('.bv-graph-selected')).toContainText('Uniform convergence');
    await expect(map.locator('.bv-graph-outgoing')).toBeVisible();
    await expect(map.locator('.bv-graph-edge')).toHaveCount(2);
    await expect(map.locator('.bv-hierarchy-edge')).toHaveCount(1);
    await expect(map.locator('.bv-reference-edge')).toHaveCount(1);
    await openFilters(page);
    for (const label of ['Filter by state', 'Filter by namespace', 'Filter by references']) {
        expect(await page.getByLabel(label).evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(36);
    }
    await find(page, 'foundation', 'Completeness');
    await expect(map.locator('.bv-graph-incoming')).toHaveCount(222);
    await find(page, 'relative', 'Relative reference parent');
    await expect(map.locator('.bv-graph-children')).toHaveCount(1);
    await expect(map.locator('.bv-graph-outgoing')).toHaveCount(0);
    await expect(map.locator('.bv-hierarchy-edge')).toHaveCount(1);
    await expect(map.locator('.bv-reference-edge')).toHaveCount(1);
});
test('10,000 notes keep a bounded rendered list and support reveal', async ({ page }) => {
    test.setTimeout(60000);
    await start(page, 10000);
    await expect(page.getByTestId('blocks-list').locator('.bv-row').first()).toBeVisible();
    expect(await page.getByTestId('blocks-list').locator('.bv-row').count()).toBeLessThan(50);
    await find(page, 'foundation', 'Completeness');
    await page.getByTestId('block-map-node-bv-foundation').click();
    await page.getByLabel('Relationship map').locator('.bv-graph-selected').click();
    await expect(page.getByTestId('block-map-node-bv-foundation')).toBeVisible();
    await page.getByLabel('Information density').selectOption('Workspace');
    expect(await page.getByTestId('blocks-list').locator('.bv-row').count()).toBeLessThan(20);
});
test('deep paths and long titles remain inspectable on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await start(page);
    await find(page, 'long', 'atlas/long');
    await expect(page.getByLabel('Block inspector').locator('.bv-graph-selected')).toContainText('qualifications');
    expect(await page.locator('.bv-shell').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await openFilters(page);
    await page.getByText('Show matches only').click();
    await page.locator('.bv-filter-menu summary').click();
    await find(page, 'deep', 'atlas/deep');
    await expect(page.getByLabel('Block inspector').locator('.bv-graph-selected code')).toContainText('level-32/limit');
});

test('keyboard selection, Enter, namespace and reference filters work together', async ({ page }) => {
    await start(page);
    await openFilters(page);
    await page.getByLabel('Filter by namespace').selectOption('atlas');
    await page.getByLabel('Filter by references').selectOption('incoming');
    await page.getByLabel('Search blocks view').fill('completeness');
    const row = page.getByTestId('block-map-node-bv-foundation');
    await row.focus();
    await page.keyboard.press('Space');
    await expect(page.getByLabel('Block inspector').locator('.bv-graph-selected')).toContainText('Completeness');
    await expect(page.getByRole('heading', { name: 'Blocks View' })).toBeVisible();
    await row.press('Enter');
    await expect(page.getByRole('heading', { name: 'Blocks View' })).toHaveCount(0);
    await page.getByLabel('Open blocks view').click();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Open blocks view')).toBeFocused();
});

test('structure expansion and scroll position survive relationship exploration', async ({ page }) => {
    await start(page, 1000);
    await page.getByLabel('Expand atlas', { exact: true }).click();
    await page.getByLabel('Expand atlas/applications', { exact: true }).click();
    const list = page.getByTestId('blocks-list');
    await list.evaluate(e => { e.scrollTop = 1200; });
    await expect.poll(() => list.evaluate(e => e.scrollTop)).toBe(1200);
    await expect(page.locator('.bv-viewing-bar')).toContainText('atlas');
    await expect(page.locator('.bv-viewing-bar')).toContainText('applications');
    await expect.poll(() => list.evaluate(e => e.scrollTop)).toBe(1200);
    expect(await list.locator('.bv-row').count()).toBeLessThan(50);
});

test('expanding a branch does not reset the viewing breadcrumb', async ({ page }) => {
    await start(page, 1000);
    await page.getByLabel('Expand atlas', { exact: true }).click();
    const applications = page.getByLabel('Expand atlas/applications', { exact: true });
    await applications.scrollIntoViewIfNeeded();
    const list = page.getByTestId('blocks-list');
    await list.evaluate(e => e.dispatchEvent(new Event('scroll')));
    await expect(page.locator('.bv-viewing-bar')).toContainText('atlas');
    await applications.click();
    await expect(page.locator('.bv-viewing-bar')).toContainText('atlas');
    await expect(page.locator('.bv-viewing-bar')).not.toContainText('$G_2$');
});

test('an open branch becomes current when its row is halfway above the list edge', async ({ page }) => {
    await start(page, 1000);
    await page.getByLabel('Expand atlas', { exact: true }).click();
    const applications = page.getByLabel('Expand atlas/applications', { exact: true });
    await applications.scrollIntoViewIfNeeded();
    const geometry = await applications.evaluate(button => {
        const row = button.parentElement as HTMLElement;
        return { top: row.offsetTop, height: row.offsetHeight };
    });
    await applications.click();
    const list = page.getByTestId('blocks-list');

    await list.evaluate((element, top) => { element.scrollTop = top; }, geometry.top + geometry.height * .49);
    await expect(page.locator('.bv-viewing-bar')).not.toContainText('applications');

    await list.evaluate((element, top) => { element.scrollTop = top; }, geometry.top + geometry.height * .51);
    await expect(page.locator('.bv-viewing-bar')).toContainText('atlas');
    await expect(page.locator('.bv-viewing-bar')).toContainText('applications');
});
