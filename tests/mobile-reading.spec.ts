import { devices, expect, test } from 'playwright/test';

const { defaultBrowserType: _phoneBrowser, ...iPhone } = devices['iPhone 13'];
const { defaultBrowserType: _tabletBrowser, ...iPad } = devices['iPad Mini'];

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

async function openReadingFixture(page: import('playwright/test').Page, request: import('playwright/test').APIRequestContext, openChild = false) {
    const child = await (await request.post('/api/blocks', { data: {
        title: 'Touch child', label: 'touch:child', content: 'Child text'
    } })).json();
    const source = `Tap this text and $x^2$ to read.\n\n[[touch:child${openChild ? '∨' : ''}]]`;
    const root = await (await request.post('/api/blocks', { data: {
        title: 'Touch root', label: 'touch:root', content: source
    } })).json();
    expect((await request.post('/api/workspace/session', { data: {
        openTabs: [root.id], activeTab: root.id, persistForTest: true
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const panel = page.locator(`[role="tabpanel"]#block-tab-panel-${root.id}`);
    await expect(panel).toBeVisible();
    return { root, child, source, panel };
}

async function expectEmbeddedEditorReentry(page: import('playwright/test').Page, request: import('playwright/test').APIRequestContext) {
    const { root, child, source, panel } = await openReadingFixture(page, request, true);
    const toggle = page.getByTestId('mobile-edit-toggle');
    const childContent = panel.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-content');
    await expect(childContent).toHaveAttribute('contenteditable', 'false');

    await toggle.tap();
    await expect(childContent).toHaveAttribute('contenteditable', 'true');
    await childContent.tap();
    await expect(childContent).toBeFocused();
    await page.keyboard.insertText('!');

    await toggle.tap();
    await expect(childContent).toHaveAttribute('contenteditable', 'false');
    await expect(childContent).not.toBeFocused();

    await toggle.tap();
    // No root-editor tap should be needed to refresh an already-open child.
    await expect(childContent).toHaveAttribute('contenteditable', 'true');
    await expect(childContent).not.toBeFocused();
    await childContent.tap();
    await expect(childContent).toBeFocused();
    await page.keyboard.insertText('2');
    await expect(childContent).toContainText('!');
    await expect(childContent).toContainText('2');

    await toggle.tap();
    await expect.poll(async () => (await request.get(`/api/blocks/${child.id}/raw`)).text()).toContain('!');
    await expect.poll(async () => (await request.get(`/api/blocks/${child.id}/raw`)).text()).toContain('2');
    expect(await (await request.get(`/api/blocks/${root.id}/raw`)).text()).toBe(source);
}

async function expectHorizontalTabStrip(page: import('playwright/test').Page, request: import('playwright/test').APIRequestContext) {
    const ids: string[] = [];
    for (let index = 0; index < 10; index++) {
        const block = await (await request.post('/api/blocks', { data: {
            title: `Scrollable tab ${index}`, label: `scrollable:tab:${index}`, content: `Tab ${index}`
        } })).json();
        ids.push(block.id);
    }
    expect((await request.post('/api/workspace/session', { data: {
        openTabs: ids, activeTab: ids[0], persistForTest: true
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const strip = page.getByRole('tablist', { name: 'Open tabs' });
    await expect(strip.getByRole('tab')).toHaveCount(ids.length);
    const geometry = await strip.evaluate(element => {
        const style = getComputedStyle(element);
        element.scrollLeft = element.scrollWidth;
        element.scrollTop = 50;
        return { horizontal: element.scrollLeft, vertical: element.scrollTop,
            verticalOverflow: element.scrollHeight - element.clientHeight,
            overflowY: style.overflowY, touchAction: style.touchAction };
    });
    expect(geometry.horizontal).toBeGreaterThan(0);
    expect(geometry.vertical, JSON.stringify(geometry)).toBe(0);
    expect(geometry.verticalOverflow).toBe(0);
    expect(geometry.overflowY).toBe('hidden');
    expect(geometry.touchAction).toBe('pan-x');
    await expect(strip.getByRole('tab').last()).toBeInViewport();
}

test.describe('iPhone reading', () => {
    test.use(iPhone);

    test('scrolls open tabs horizontally without vertical movement', async ({ page, request }) => {
        await expectHorizontalTabStrip(page, request);
    });

    test('re-enters an open embedded editor after two pencil-toggle cycles', async ({ page, request }) => {
        await expectEmbeddedEditorReentry(page, request);
    });

    test('refreshes a nested embedded editor after returning from reading mode', async ({ page, request }) => {
        const leaf = await (await request.post('/api/blocks', { data: {
            title: 'Touch leaf', label: 'touch:leaf', content: 'Leaf text'
        } })).json();
        const child = await (await request.post('/api/blocks', { data: {
            title: 'Touch child', label: 'touch:child', content: 'Child text\n[[touch:leaf∨]]'
        } })).json();
        const root = await (await request.post('/api/blocks', { data: {
            title: 'Touch root', label: 'touch:root', content: 'Root text\n[[touch:child∨]]'
        } })).json();
        expect((await request.post('/api/workspace/session', { data: {
            openTabs: [root.id], activeTab: root.id, persistForTest: true
        } })).ok()).toBeTruthy();
        await page.goto('/');

        const panel = page.locator(`[role="tabpanel"]#block-tab-panel-${root.id}`);
        const leafContent = panel.getByTestId(`embedded-editor-host-${leaf.id}`).locator('.cm-content');
        const toggle = page.getByTestId('mobile-edit-toggle');
        await expect(leafContent).toHaveAttribute('contenteditable', 'false');
        await toggle.tap();
        await expect(leafContent).toHaveAttribute('contenteditable', 'true');
        await leafContent.tap();
        await expect(leafContent).toBeFocused();
        await toggle.tap();
        await expect(leafContent).toHaveAttribute('contenteditable', 'false');
        await toggle.tap();
        await expect(leafContent).toHaveAttribute('contenteditable', 'true');
        await leafContent.tap();
        await expect(leafContent).toBeFocused();
        expect(await (await request.get(`/api/blocks/${child.id}/raw`)).text()).toBe('Child text\n[[touch:leaf∨]]');
    });

    test('requires Edit for caret placement and keeps reading taps rendered', async ({ page, request }) => {
        const { root, child, source, panel } = await openReadingFixture(page, request);
        const editor = panel.locator('.cm-editor').first();
        const content = editor.locator(':scope > .cm-scroller > .cm-content');
        const toggle = page.getByTestId('mobile-edit-toggle');
        await expect(toggle).toHaveAttribute('data-mode', 'reading');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await expect(content).toHaveAttribute('contenteditable', 'false');
        const toolbar = page.getByTestId('app-toolbar');
        const toolbarWidths = await toolbar.evaluate(element => ({ visible: element.clientWidth, total: element.scrollWidth }));
        expect(toolbarWidths.total).toBeGreaterThan(toolbarWidths.visible);
        const searchButton = page.getByRole('button', { name: 'Search', exact: true });
        const searchBounds = await searchButton.boundingBox();
        expect(searchBounds).not.toBeNull();
        expect(searchBounds!.x + searchBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        await toolbar.evaluate(element => { element.scrollLeft = element.scrollWidth; });
        await expect(page.getByLabel('Open settings')).toBeInViewport();

        await panel.getByText('Tap this text and', { exact: false }).first().tap();
        await editor.locator('.cm-math-inline').tap();
        await expect(editor.locator('.cm-math-editing')).toHaveCount(0);
        await expect(content).not.toBeFocused();

        await editor.getByText('Touch child', { exact: true }).tap();
        const childHost = panel.getByTestId(`embedded-editor-host-${child.id}`);
        await expect(childHost).toContainText('Child text');
        await expect(childHost.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
        expect(await (await request.get(`/api/blocks/${root.id}/raw`)).text()).toBe(source);

        const scrollBeforeEdit = await panel.evaluate(element => element.scrollTop);
        await toggle.tap();
        await expect(content).toHaveAttribute('contenteditable', 'true');
        await expect(toggle).toHaveAttribute('data-mode', 'editing');
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        expect(await panel.evaluate(element => element.scrollTop)).toBe(scrollBeforeEdit);
        await expect(content).not.toBeFocused();

        const normalBottom = await toggle.evaluate(element => parseFloat(getComputedStyle(element).bottom));
        await page.evaluate(() => {
            const viewport = window.visualViewport!;
            Object.defineProperty(viewport, 'height', { configurable: true, value: viewport.height - 240 });
            viewport.dispatchEvent(new Event('resize'));
        });
        await expect.poll(() => toggle.evaluate(element => parseFloat(getComputedStyle(element).bottom)))
            .toBeGreaterThan(normalBottom + 200);

        await editor.locator('.cm-math-inline').tap();
        await expect(content).toContainText('$x^2$');
        await content.tap();
        await page.keyboard.insertText('X');
        await expect(content).toContainText('X');
        await toggle.tap();
        await expect(content).toHaveAttribute('contenteditable', 'false');
        await expect(toggle).toHaveAttribute('data-mode', 'reading');
        await expect(content).not.toBeFocused();
    });
});

test.describe('iPad reading', () => {
    test.use(iPad);

    test('scrolls open tabs horizontally without vertical movement', async ({ page, request }) => {
        await expectHorizontalTabStrip(page, request);
    });

    test('re-enters an open embedded editor after two pencil-toggle cycles', async ({ page, request }) => {
        await expectEmbeddedEditorReentry(page, request);
    });

    test('opens in reading state on a tablet', async ({ page, request }) => {
        const { panel } = await openReadingFixture(page, request);
        const toggle = page.getByTestId('mobile-edit-toggle');
        await expect(toggle).toHaveAttribute('data-mode', 'reading');
        await expect(panel.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false');
        await page.setViewportSize({ width: 1194, height: 834 });
        const toolbar = page.getByTestId('app-toolbar');
        await expect.poll(() => toolbar.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        const createBounds = await page.getByRole('button', { name: 'Create new block' }).boundingBox();
        expect(createBounds).not.toBeNull();
        expect(createBounds!.x + createBounds!.width).toBeGreaterThan(1194 - 70);
        const noteRight = await panel.locator('[data-block-root]').boundingBox();
        const toggleBounds = await toggle.boundingBox();
        expect(noteRight).not.toBeNull();
        expect(toggleBounds).not.toBeNull();
        expect(toggleBounds!.x + toggleBounds!.width).toBeLessThanOrEqual(noteRight!.x + noteRight!.width);
        expect(toggleBounds!.x).toBeGreaterThan(noteRight!.x + noteRight!.width - 100);
    });
});

test.describe('narrow desktop', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('keeps desktop editing when the browser window is narrow', async ({ page, request }) => {
        const { panel } = await openReadingFixture(page, request);
        await expect(page.getByTestId('mobile-edit-toggle')).toHaveCount(0);
        await expect(panel.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'true');
    });
});
