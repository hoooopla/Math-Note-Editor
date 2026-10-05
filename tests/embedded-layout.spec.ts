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

test('reveals the logical suffix even while a previous title caret remains rendered', async ({ page, request }) => {
    await request.post('/api/test/reset');
    await request.post('/api/blocks', { data: {
        title: 'Stale projection child', label: 'test:stale-projection-child',
        content: Array.from({ length: 55 }, (_, index) => `projection row ${index}`).join('\n')
    } });
    await request.post('/api/blocks', { data: {
        title: 'Stale projection source', label: 'test:stale-projection-source',
        content: '[[test:stale-projection-child∨]]projection-tail'
    } });
    await page.goto('/');
    await page.getByRole('button', { name: /^Search\b/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill('test:stale-projection-source');
    await search.press('Enter');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const tail = page.getByText('projection-tail', { exact: true });
    await expect.poll(() => panel.locator('.cm-embedded-block-wrapper[data-embed-part="body"]')
        .evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(1000);
    await tail.click({ position: { x: 1, y: 8 } });
    await page.keyboard.press('ArrowLeft');
    await expect(panel.getByTestId('embedded-title-caret')).toBeVisible();
    await expect(panel.locator('[data-embed-nav-title]')).toBeInViewport();
    try {
        await panel.evaluate(async element => {
            const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
            const pluginUrl = '/src/lib/editor/embedded-block-plugin.tsx';
            const { EditorView } = await import(viewUrl);
            const { setEmbeddedObjectSelection, scheduleEmbeddedNavigationReveal } = await import(pluginUrl);
            const editor = element.querySelector('.cm-editor');
            const view = EditorView.findFromDOM(editor);
            const title = editor.querySelector('[data-embed-keyboard-selected="true"]');
            const wrapper = title.closest<HTMLElement>('.cm-embedded-block-wrapper');
            // Hold the previous React projection without changing the source.
            // It stays visible long enough to expose a premature one-shot reveal.
            const stale = wrapper.cloneNode(true) as HTMLElement;
            const rect = wrapper.getBoundingClientRect();
            stale.dataset.testid = 'stale-title-projection';
            stale.setAttribute('aria-hidden', 'true');
            stale.setAttribute('inert', '');
            Object.assign(stale.style, { position: 'fixed', top: `${rect.top}px`, left: `${rect.left}px` });
            editor.appendChild(stale);
            view.dispatch({
                selection: { anchor: Number(wrapper.dataset.embedTo) },
                effects: setEmbeddedObjectSelection.of(null)
            });
            scheduleEmbeddedNavigationReveal(view);
        });
        await expect(tail).toBeInViewport();
    } finally {
        await panel.getByTestId('stale-title-projection').evaluate(element => element.remove());
    }
});

for (const cancelWith of ['wheel', 'edit'] as const) {
test(`cancels pending reopening refinement after a newer ${cancelWith}`, async ({ page, request }) => {
    await request.post('/api/test/reset');
    const child = await (await request.post('/api/blocks', { data: {
        title: 'Pending reopen child', label: 'test:pending-reopen-child',
        content: Array.from({ length: 200 }, (_, index) => `pending row ${index}`).join('\n')
    } })).json();
    await request.post('/api/blocks', { data: {
        title: 'Pending reopen source', label: 'test:pending-reopen-source',
        content: '[[test:pending-reopen-child]]tail'
    } });
    await page.goto('/');
    await page.getByRole('button', { name: /^Search\b/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill('test:pending-reopen-source');
    await search.press('Enter');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    await panel.locator('[data-embed-nav-title]').click();
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-content').first()).toContainText('pending row 0');
    const pending = panel.locator('[data-explicit-reopen-pending]');
    await expect(pending).toHaveCount(1);
    if (cancelWith === 'wheel') {
        const box = await panel.boundingBox();
        await page.mouse.move(box!.x + 20, box!.y + 120);
        await page.mouse.wheel(0, 50);
    } else {
        await panel.locator('.cm-content').first().fill('edited [[test:pending-reopen-child∨]]tail');
    }
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`)).toBeVisible();
});
}

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
        await page.getByRole('button', { name: /^Search\b/ }).click();
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
        await page.getByRole('button', { name: /^Search\b/ }).click();
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
