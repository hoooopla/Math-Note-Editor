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
        const controls = panel.getByTestId('mobile-reading-controls');
        await expect(controls).toContainText('Reading');
        await expect(content).toHaveAttribute('contenteditable', 'false');
        const searchButton = page.getByRole('button', { name: 'Search', exact: true });
        const searchBounds = await searchButton.boundingBox();
        expect(searchBounds).not.toBeNull();
        expect(searchBounds!.x + searchBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

        await panel.getByText('Tap this text and', { exact: false }).first().tap();
        await editor.locator('.cm-math-inline').tap();
        await expect(editor.locator('.cm-math-editing')).toHaveCount(0);
        await expect(content).not.toBeFocused();

        await editor.getByText('Touch child', { exact: true }).tap();
        const childHost = panel.getByTestId(`embedded-editor-host-${child.id}`);
        await expect(childHost).toContainText('Child text');
        await expect(childHost.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
        expect(await (await request.get(`/api/blocks/${root.id}/raw`)).text()).toBe(source);

        await controls.getByRole('button', { name: 'Edit' }).tap();
        await expect(content).toHaveAttribute('contenteditable', 'true');
        await expect(controls).toContainText('Editing');
        await editor.locator('.cm-math-inline').tap();
        await expect(content).toContainText('$x^2$');
        await content.tap();
        await page.keyboard.insertText('X');
        await expect(content).toContainText('X');
        await controls.getByRole('button', { name: 'Done' }).tap();
        await expect(content).toHaveAttribute('contenteditable', 'false');
        await expect(content).not.toBeFocused();
    });
});

test.describe('iPad reading', () => {
    test.use(iPad);

    test('opens in reading state on a tablet', async ({ page, request }) => {
        const { panel } = await openReadingFixture(page, request);
        await expect(panel.getByTestId('mobile-reading-controls').getByRole('button', { name: 'Edit' })).toBeVisible();
        await expect(panel.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false');
    });
});

test.describe('narrow desktop', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('keeps desktop editing when the browser window is narrow', async ({ page, request }) => {
        const { panel } = await openReadingFixture(page, request);
        await expect(panel.getByTestId('mobile-reading-controls')).toHaveCount(0);
        await expect(panel.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'true');
    });
});
