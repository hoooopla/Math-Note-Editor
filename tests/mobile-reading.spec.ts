import { devices, expect, test } from 'playwright/test';

const { defaultBrowserType: _phoneBrowser, ...iPhone } = devices['iPhone 13'];
const { defaultBrowserType: _tabletBrowser, ...iPad } = devices['iPad Mini'];

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

async function openReadingFixture(page: import('playwright/test').Page, request: import('playwright/test').APIRequestContext) {
    const child = await (await request.post('/api/blocks', { data: {
        title: 'Touch child', label: 'touch:child', content: 'Child text'
    } })).json();
    const source = 'Tap this text and $x^2$ to read.\n\n[[touch:child]]';
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

test.describe('iPhone reading', () => {
    test.use(iPhone);

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

    test('opens in reading state on a tablet', async ({ page, request }) => {
        const { panel } = await openReadingFixture(page, request);
        const toggle = page.getByTestId('mobile-edit-toggle');
        await expect(toggle).toHaveAttribute('data-mode', 'reading');
        await expect(panel.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false');
        await page.setViewportSize({ width: 1194, height: 834 });
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
