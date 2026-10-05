import { expect, test, type Page } from 'playwright/test';

const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
    const errors: string[] = [];
    runtimeErrors.set(page, errors);
    page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(({ page }) => {
    expect(runtimeErrors.get(page), 'navigation and layout must not throw browser errors').toEqual([]);
});

for (const cancelWithWheel of [false, true]) {
test(`reveals a suffix after delayed body loading${cancelWithWheel ? ' without overriding later wheel input' : ''}`, async ({ page, request }) => {
    await request.post('/api/test/reset');
    const child = await (await request.post('/api/blocks', { data: {
        title: 'Delayed suffix child', label: 'test:delayed-suffix-child',
        content: Array.from({ length: 55 }, (_, index) => `delayed row ${index}`).join('\n')
    } })).json();
    await request.post('/api/blocks', { data: {
        title: 'Delayed suffix source', label: 'test:delayed-suffix-source',
        content: '[[test:delayed-suffix-child∨]]delayed-tail'
    } });
    let releaseLoad!: () => void;
    const gate = new Promise<void>(resolve => { releaseLoad = resolve; });
    await page.route(`**/api/blocks/${child.id}`, async route => {
        await gate;
        await route.fulfill({ json: child });
    });
    try {
        await page.goto('/');
        await expect(page.getByLabel('In-memory test mode')).toBeVisible();
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill('test:delayed-suffix-source');
        await search.press('Enter');
        const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
        const title = panel.locator('[data-embed-nav-title]').filter({ hasText: 'Delayed suffix child' });
        const tail = page.getByText('delayed-tail', { exact: true });
        await expect(page.getByLabel('Loading embedded note Delayed suffix child')).toBeVisible();
        await tail.click({ position: { x: 1, y: 8 } });
        await page.keyboard.press('ArrowLeft');
        await expect(title.getByTestId('embedded-title-caret')).toBeVisible();
        await page.keyboard.press('ArrowRight');
        // Hold the network response past the old one-frame reveal deadline.
        await page.waitForTimeout(200);
        if (cancelWithWheel) {
            const bounds = await panel.boundingBox();
            await page.mouse.move(bounds!.x + 20, bounds!.y + 20);
            await page.mouse.wheel(0, -80);
        }
        releaseLoad();
        await expect(page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-content').first()).toContainText('delayed row 0');
        if (cancelWithWheel) {
            // Allow every deferred frame to run before checking cancellation.
            await page.waitForTimeout(400);
            expect(await panel.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2);
        } else {
            await expect(tail).toBeInViewport();
            expect(await panel.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
        }
    } finally {
        releaseLoad();
    }
});
}

test('keeps a measured widget estimate during descendant hydration but invalidates a real collapse', async ({ page, request }) => {
    await request.post('/api/test/reset');
    const leaf = await (await request.post('/api/blocks', { data: {
        title: 'Hydrating leaf', label: 'test:hydrating-leaf', content: 'loaded leaf'
    } })).json();
    const body = `${Array.from({ length: 35 }, (_, index) => `body row ${index}`).join('\n')}\n[[test:hydrating-leaf∨]]`;
    const middle = await (await request.post('/api/blocks', { data: {
        title: 'Measured middle', label: 'test:measured-middle', content: body
    } })).json();
    await request.post('/api/blocks', { data: {
        title: 'Hydration source', label: 'test:hydration-source', content: '[[test:measured-middle∨]]'
    } });
    // Leave one descendant unloaded while its ancestor acquires a real height.
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
    await page.route(`**/api/blocks/${leaf.id}`, async route => {
        await loadGate;
        await route.fulfill({ json: leaf });
    });
    try {
        await page.goto('/');
        await expect(page.getByLabel('In-memory test mode')).toBeVisible();
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill('test:hydration-source');
        await search.press('Enter');
        const host = page.getByTestId(`embedded-editor-host-${middle.id}`);
        await expect(host.locator('.cm-content').first()).toContainText('body row 0');
        const wrapper = host.locator('xpath=ancestor::*[contains(@class,"cm-embedded-block-wrapper")][1]');
        await expect.poll(() => wrapper.evaluate(element =>
            (element as any).__embeddedWidgetOwner?.estimatedHeight ?? -1)).toBeGreaterThan(500);
        const estimates = await wrapper.evaluate(async (element, ids) => {
            const storeUrl = '/src/store/index.ts';
            const { useStore } = await import(storeUrl);
            const widget = (element as any).__embeddedWidgetOwner;
            const before = widget.estimatedHeight;
            const state = useStore.getState();
            const wasUnloaded = state.blocksById[ids.leaf].content === undefined;
            // Read in the same task, before ResizeObserver can publish a new
            // height. Previously the live fingerprint made this return -1.
            useStore.setState({ blocksById: { ...state.blocksById,
                [ids.leaf]: { ...state.blocksById[ids.leaf], content: 'loaded leaf' }
            } });
            const hydrated = widget.estimatedHeight;
            const loaded = useStore.getState();
            useStore.setState({ blocksById: { ...loaded.blocksById,
                [ids.middle]: { ...loaded.blocksById[ids.middle], content: 'collapsed body' }
            } });
            return { before, hydrated, collapsed: widget.estimatedHeight, wasUnloaded };
        }, { leaf: leaf.id, middle: middle.id });
        expect(estimates.wasUnloaded).toBe(true);
        expect(estimates.hydrated).toBe(estimates.before);
        expect(estimates.collapsed).toBe(-1);
    } finally {
        releaseLoad();
    }
});
