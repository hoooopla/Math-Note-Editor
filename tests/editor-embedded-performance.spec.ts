import { expect, test } from 'playwright/test';
import { openEditor, replaceEditorText } from './helpers/editor';

test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset');
    expect(response.ok()).toBeTruthy();
});

test('prepares the real embedded renderer more than two screens before it becomes visible', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:three-screen-target-${suffix}`;
    const sourceLabel = `test:three-screen-source-${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Three screen render target',
            label: targetLabel,
            content: 'Prepared with the real editor.\n$e^{i\\theta}$\nFinal prepared row.'
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Three screen render source',
            label: sourceLabel,
            content: `${Array.from({ length: 68 }, (_, index) => `render-ahead row ${index}`).join('\n')}\n[[${targetLabel}∨]]\n${Array.from({ length: 30 }, (_, index) => `following row ${index}`).join('\n')}`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const targetHost = page.getByTestId(`embedded-editor-host-${target.id}`);
    await expect(targetHost).toHaveAttribute('data-editor-phase', 'warm');
    await expect(targetHost.locator('[data-editor-dormant="true"]')).toBeVisible();
    await expect(targetHost).toContainText('Final prepared row.');
    await expect(targetHost.locator('.katex')).toBeVisible();

    const initialGeometry = await targetHost.evaluate(element => {
        const panel = element.closest<HTMLElement>('[role="tabpanel"]')!;
        const panelRect = panel.getBoundingClientRect();
        return {
            distance: element.getBoundingClientRect().top - panelRect.bottom,
            viewportHeight: panel.clientHeight,
            scrollTop: panel.scrollTop
        };
    });
    expect(initialGeometry.scrollTop).toBe(0);
    expect(initialGeometry.distance).toBeGreaterThan(initialGeometry.viewportHeight * 1.25);
    expect(initialGeometry.distance).toBeLessThan(initialGeometry.viewportHeight * 3.1);

    await panel.evaluate(async (element, destination) => {
        const trace = { loadingVisibleFrames: 0, active: true };
        (window as any).__threeScreenRenderTrace = trace;
        const sample = () => {
            if (!trace.active) return;
            const viewport = element.getBoundingClientRect();
            const visibleLoading = Array.from(element.querySelectorAll<HTMLElement>('[aria-label^="Loading embedded note"]'))
                .some(node => {
                    const rect = node.getBoundingClientRect();
                    return rect.bottom > viewport.top && rect.top < viewport.bottom;
                });
            if (visibleLoading) trace.loadingVisibleFrames += 1;
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        const start = element.scrollTop;
        for (let step = 1; step <= 24; step += 1) {
            element.scrollTop = start + (destination - start) * (step / 24);
            element.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => setTimeout(resolve, 18));
        }
        trace.active = false;
    }, initialGeometry.viewportHeight * 2.4);
    const loadingVisibleFrames = await page.evaluate(() => (window as any).__threeScreenRenderTrace.loadingVisibleFrames);
    expect(loadingVisibleFrames).toBe(0);
    await expect(targetHost).toContainText('Final prepared row.');
});

test('keeps rapid-scroll destinations warm with the real renderer and promotes only the clicked body', async ({ page }) => {
    const suffix = Date.now();
    const leafLabel = `test:lazy-editor-leaf-${suffix}`;
    const childLabel = `test:lazy-editor-child-${suffix}`;
    const targetLabel = `test:lazy-editor-target-${suffix}`;
    const sourceLabel = `test:lazy-editor-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Prefetched leaf', label: leafLabel, content: 'Recursively prefetched leaf content.' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Prefetched child', label: childLabel, content: `Child content.\n[[${leafLabel}∨]]` }
    });
    const target = await (await page.request.post('/api/blocks', {
        data: { title: 'Lazy embedded target', label: targetLabel, content: `Nested content with $x^2$.\n\\[\n\\int_{-\\pi}^{\\pi} f(y)\\,dy = 0\n\\]\n[[${childLabel}∨]]` }
    })).json();
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

    await page.locator('[role="tabpanel"][aria-hidden="false"]').evaluate(async element => {
        const target = element.scrollHeight - element.clientHeight;
        for (let step = 1; step <= 8; step += 1) {
            element.scrollTop = target * (step / 8);
            element.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => setTimeout(resolve, 35));
        }
        (window as any).__embeddedScrollTestTimer = window.setInterval(() => element.dispatchEvent(new Event('scroll')), 50);
    });
    // The destination is warmed with the real renderer while scrolling. There
    // is no lightweight surface that can flash into a different layout later.
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="embedded-editor-host-"]').first()).toBeVisible();
    const targetHost = page.getByTestId(`embedded-editor-host-${target.id}`);
    await expect(targetHost).toHaveAttribute('data-editor-phase', 'warm');
    await expect(targetHost.locator('[data-editor-dormant="true"]').first()).toBeVisible();
    await expect(targetHost).toContainText('Nested content with');
    await expect(targetHost).toContainText('Recursively prefetched leaf content.');
    await expect(targetHost.locator('.katex').first()).toBeVisible();
    await expect(targetHost.locator('[data-testid^="embedded-static-preview-"]')).toHaveCount(0);
    await page.evaluate(() => {
        window.clearInterval((window as any).__embeddedScrollTestTimer);
        delete (window as any).__embeddedScrollTestTimer;
    });
    // Idling does not trigger a renderer swap or add a second representation.
    await page.waitForTimeout(350);
    await expect(targetHost).toHaveAttribute('data-editor-mounted', 'true');
    await expect(targetHost.locator('[data-editor-dormant="true"]').first()).toBeVisible();
    const dormantEditorCount = await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').count();
    expect(dormantEditorCount).toBeGreaterThan(1);

    // Titles remain toggle controls inside a dormant editor.
    const childTitle = targetHost.locator('[data-embed-nav-title="true"]').filter({ hasText: 'Prefetched child' }).first();
    const expandedHeight = await targetHost.evaluate(element => element.getBoundingClientRect().height);
    await childTitle.click();
    await expect(targetHost).not.toContainText('Recursively prefetched leaf content.');
    await expect(targetHost).toHaveAttribute('data-editor-activated', 'false');
    await expect.poll(() => targetHost.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(expandedHeight - 10);
    await expect.poll(() => targetHost.locator('[data-embed-nav-title="true"]').filter({ hasText: 'Prefetched child' }).count()).toBeGreaterThan(0);
    await targetHost.locator('[data-embed-nav-title="true"]').filter({ hasText: 'Prefetched child' }).first().click();
    await expect(targetHost).toContainText('Recursively prefetched leaf content.');

    // A content click promotes the same view without adding another editor.
    const activationGeometryBefore = await targetHost.evaluate(element => {
        const panel = element.closest<HTMLElement>('[role="tabpanel"]')!;
        const rect = element.getBoundingClientRect();
        return { top: rect.top, height: rect.height, scrollTop: panel.scrollTop };
    });
    await targetHost.locator('.cm-line').first().click({ position: { x: 45, y: 8 } });
    await expect(targetHost).toHaveAttribute('data-editor-activated', 'true');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content')).toHaveCount(dormantEditorCount);
    await expect(page.locator('.cm-math-inline .katex').last()).toBeVisible();
    const activationGeometryAfter = await targetHost.evaluate(element => {
        const panel = element.closest<HTMLElement>('[role="tabpanel"]')!;
        const rect = element.getBoundingClientRect();
        return {
            top: rect.top,
            height: rect.height,
            scrollTop: panel.scrollTop
        };
    });
    const activationGeometry = JSON.stringify({ activationGeometryBefore, activationGeometryAfter });
    expect(Math.abs(activationGeometryAfter.top - activationGeometryBefore.top), activationGeometry).toBeLessThanOrEqual(1);
    expect(Math.abs(activationGeometryAfter.height - activationGeometryBefore.height), activationGeometry).toBeLessThanOrEqual(1);
    expect(Math.abs(activationGeometryAfter.scrollTop - activationGeometryBefore.scrollTop), activationGeometry).toBeLessThanOrEqual(1);

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const mountedScrollHeight = await panel.evaluate(element => element.scrollHeight);
    await panel.evaluate(element => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
    });
    // The parent CodeMirror virtualizes off-screen lines, but the embed keeps
    // its activation mode and returns directly as an editor when revisited.
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content')).toHaveCount(1);
    await expect(page.getByText('Loading embedded note…')).toHaveCount(0);

    await panel.evaluate(element => {
        const artifacts: string[] = [];
        const inspect = (snapshot: Element) => {
            if (snapshot.querySelector('.cm-cursorLayer')) artifacts.push('cursor');
            if (snapshot.querySelector('.cm-selectionLayer')) artifacts.push('selection');
            if (snapshot.querySelector('.cm-tooltip')) artifacts.push('tooltip');
            if (snapshot.querySelector('.embedded-title-caret')) artifacts.push('title-caret');
            if (snapshot.querySelector('[data-embed-keyboard-selected]')) artifacts.push('object-selection');
            if (snapshot.querySelector('[contenteditable]')) artifacts.push('editable');
        };
        const observer = new MutationObserver(records => {
            for (const record of records) {
                for (const node of Array.from(record.addedNodes)) {
                    if (!(node instanceof Element)) continue;
                    if (node.matches('.cm-embedded-snapshot')) inspect(node);
                    node.querySelectorAll('.cm-embedded-snapshot').forEach(inspect);
                }
            }
        });
        observer.observe(element, { childList: true, subtree: true });
        (window as any).__embeddedSnapshotArtifacts = artifacts;
        (window as any).__embeddedSnapshotObserver = observer;
    });
    await panel.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').count()).toBeGreaterThan(1);
    await expect.poll(() => panel.evaluate(element => element.scrollHeight)).toBeGreaterThanOrEqual(mountedScrollHeight - 1);
    const snapshotArtifacts = await page.evaluate(() => {
        (window as any).__embeddedSnapshotObserver?.disconnect();
        return (window as any).__embeddedSnapshotArtifacts as string[];
    });
    expect(snapshotArtifacts).toEqual([]);
});

test('keeps slow upward scrolling stable while an embedded editor remounts above the viewport', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:slow-up-target-${suffix}`;
    const sourceLabel = `test:slow-up-source-${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Slow upward target',
            label: targetLabel,
            content: `${Array.from({ length: 18 }, (_, index) => `embedded line ${index}`).join('\n')}\n\\[\\sum_{i=1}^{n} i^2\\]`
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Slow upward source',
            label: sourceLabel,
            content: `${Array.from({ length: 70 }, (_, index) => `before ${index}`).join('\n')}\n[[${targetLabel}∨]]\n${Array.from({ length: 70 }, (_, index) => `after ${index}`).join('\n')}`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');

    await panel.evaluate(element => {
        element.scrollTop = element.scrollHeight / 2;
        element.dispatchEvent(new Event('scroll'));
    });
    const targetHost = page.getByTestId(`embedded-editor-host-${target.id}`);
    await targetHost.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await expect(targetHost).toHaveAttribute('data-editor-phase', 'warm');
    await expect(targetHost).toContainText('embedded line 17');
    const measuredHeight = await targetHost.evaluate(element => element.getBoundingClientRect().height);
    expect(measuredHeight).toBeGreaterThan(200);

    await panel.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
    });
    await expect(targetHost).toHaveCount(0);
    // The jump to the bottom intentionally bypasses wheel/trackpad pacing.
    // Let CodeMirror finish measuring that new viewport before this test starts
    // judging the subsequent slow, steady upward movement.
    await page.waitForTimeout(250);

    const movement = await panel.evaluate(async element => {
        let maximumVisualDeviation = 0;
        let maximumReverseMovement = 0;
        let firstUnexpected: Record<string, number> | null = null;
        let anchoredSamples = 0;
        for (let step = 0; step < 180 && element.scrollTop > 0; step += 1) {
            const before = element.scrollTop;
            const panelRect = element.getBoundingClientRect();
            const targetY = panelRect.top + Math.min(120, panelRect.height / 4);
            const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-embed-nav-title="true"], .cm-line'))
                .map(candidate => ({ candidate, rect: candidate.getBoundingClientRect() }))
                .filter(({ rect }) => rect.bottom > panelRect.top && rect.top < panelRect.bottom && rect.height > 0)
                .sort((left, right) => Math.abs(left.rect.top - targetY) - Math.abs(right.rect.top - targetY))[0]?.candidate ?? null;
            const anchorTop = anchor?.getBoundingClientRect().top ?? null;
            const intended = Math.max(0, element.scrollTop - 28);
            element.dispatchEvent(new WheelEvent('wheel', { deltaY: -28, deltaMode: WheelEvent.DOM_DELTA_PIXEL }));
            element.scrollTop = intended;
            element.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => setTimeout(resolve, 18));
            maximumReverseMovement = Math.max(maximumReverseMovement, element.scrollTop - before);
            if (anchor?.isConnected && anchorTop !== null) {
                anchoredSamples += 1;
                const expectedVisualMovement = before - intended;
                const actualVisualMovement = anchor.getBoundingClientRect().top - anchorTop;
                const deviation = Math.abs(actualVisualMovement - expectedVisualMovement);
                maximumVisualDeviation = Math.max(maximumVisualDeviation, deviation);
                if (deviation > 3 && !firstUnexpected) {
                    firstUnexpected = {
                        step,
                        before,
                        intended,
                        actual: element.scrollTop,
                        expectedVisualMovement,
                        actualVisualMovement,
                        deviation
                    };
                }
            }
        }
        return { maximumVisualDeviation, maximumReverseMovement, firstUnexpected, anchoredSamples };
    });
    // ScrollTop may move by the same amount as a corrected height above the
    // viewport. Judge the text under the user's eye instead: a remount may
    // defer one wheel step for one frame, but it must not flash or displace the
    // visible text by hundreds of pixels.
    expect(movement.anchoredSamples).toBeGreaterThan(10);
    expect(movement.maximumVisualDeviation, JSON.stringify(movement.firstUnexpected)).toBeLessThanOrEqual(28);
    expect(movement.maximumReverseMovement).toBeLessThanOrEqual(3);
});

test('does not expose cold shells or reverse direction during upward wheel scrolling', async ({ page }) => {
    const suffix = Date.now();
    const targetLabels = Array.from({ length: 7 }, (_, index) => `test:wheel-up-target-${index}-${suffix}`);
    for (const [index, label] of targetLabels.entries()) {
        await page.request.post('/api/blocks', {
            data: {
                title: `Wheel target ${index + 1}`,
                label,
                content: `${Array.from({ length: 24 }, (_, line) => `target ${index + 1} line ${line}`).join('\n')}\n\\[\\sum_{k=1}^{n} k^2\\]`
            }
        });
    }
    const sourceLabel = `test:wheel-up-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Wheel upward source',
            label: sourceLabel,
            content: targetLabels.map((label, index) => (
                `${Array.from({ length: 28 }, (_, line) => `separator ${index}-${line}`).join('\n')}\n[[${label}∨]]`
            )).join('\n')
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);

    // Visit the document once so every returning occurrence has retained
    // geometry, then let distant editors leave the outer CodeMirror viewport.
    for (let index = 0; index < 40; index += 1) {
        await page.mouse.wheel(0, 420);
        await page.waitForTimeout(12);
    }
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
    await page.waitForTimeout(1000);

    await panel.evaluate(element => {
        const trace = {
            active: true,
            coldVisibleFrames: 0,
            samples: [] as Array<{ scrollTop: number, scrollHeight: number, retained: string[] }>
        };
        (window as any).__upwardWheelTrace = trace;
        const sample = () => {
            if (!trace.active) return;
            const viewport = element.getBoundingClientRect();
            const coldVisible = Array.from(element.querySelectorAll<HTMLElement>('[data-editor-phase="cold"]'))
                .some(host => {
                    const rect = host.getBoundingClientRect();
                    return rect.bottom > viewport.top && rect.top < viewport.bottom;
                });
            if (coldVisible) trace.coldVisibleFrames += 1;
            trace.samples.push({
                scrollTop: element.scrollTop,
                scrollHeight: element.scrollHeight,
                retained: Array.from(element.querySelectorAll<HTMLElement>('[data-retained-widget-height]'))
                    .map(widget => widget.dataset.retainedWidgetHeight || '')
            });
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    });

    for (let index = 0; index < 90; index += 1) {
        await page.mouse.wheel(0, -54);
        await page.waitForTimeout(12);
    }
    const trace = await panel.evaluate(element => {
        const value = (window as any).__upwardWheelTrace as {
            active: boolean;
            coldVisibleFrames: number;
            samples: Array<{ scrollTop: number, scrollHeight: number, retained: string[] }>;
        };
        value.active = false;
        let maximumReverseJump = 0;
        let maximumEvent: unknown = null;
        for (let index = 1; index < value.samples.length; index += 1) {
            const jump = value.samples[index].scrollTop - value.samples[index - 1].scrollTop;
            if (jump > maximumReverseJump) {
                maximumReverseJump = jump;
                maximumEvent = { previous: value.samples[index - 1], current: value.samples[index] };
            }
        }
        return {
            coldVisibleFrames: value.coldVisibleFrames,
            maximumReverseJump,
            maximumEvent,
            finalScrollTop: element.scrollTop
        };
    });
    expect(trace.coldVisibleFrames).toBe(0);
    expect(trace.maximumReverseJump, JSON.stringify(trace)).toBeLessThanOrEqual(2);
});

for (const font of [null, 'Times New Roman']) {
test(`keeps the end of a deeply nested embed stable while scrolling upward${font ? ` (${font})` : ''}`, async ({ page }) => {
    test.setTimeout(60_000);
    const suffix = Date.now();
    const grandchildLabel = `test:boundary-grandchild-${suffix}`;
    const childLabel = `test:boundary-child-${suffix}`;
    const middleLabel = `test:boundary-middle-${suffix}`;
    const firstLabel = `test:boundary-first-${suffix}`;
    const applicationLabel = `test:boundary-application-${suffix}`;
    const sourceLabel = `test:boundary-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Boundary grandchild',
            label: grandchildLabel,
            content: Array.from({ length: 95 }, (_, index) => `grandchild line ${index} with $x_${index}^2$`).join('\n')
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Boundary child',
            label: childLabel,
            content: `${Array.from({ length: 28 }, (_, index) => `child line ${index}`).join('\n')}\n[[${grandchildLabel}∨]]`
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Boundary nested middle',
            label: middleLabel,
            content: `${Array.from({ length: 35 }, (_, index) => `middle line ${index}`).join('\n')}\n[[${childLabel}∨]]`
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Boundary first target',
            label: firstLabel,
            content: Array.from({ length: 90 }, (_, index) => `first line ${index}`).join('\n')
        }
    });
    const application = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Boundary application target',
            label: applicationLabel,
            content: Array.from({ length: 80 }, (_, index) => `application line ${index}`).join('\n')
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Boundary source',
            label: sourceLabel,
            content: `[[${firstLabel}∨]]\n[[${middleLabel}∨]]\n[[${applicationLabel}∨]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    if (font) {
        await page.addStyleTag({ content: `:root { --font-sans: "${font}"; }` });
        const session = await page.context().newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    for (let index = 0; index < 70; index += 1) {
        await page.mouse.wheel(0, 480);
        await page.waitForTimeout(12);
    }
    const applicationTitle = panel.locator('[data-embed-nav-title="true"]')
        .filter({ hasText: 'Boundary application target' })
        .first();
    await expect(applicationTitle).toBeVisible();
    await panel.evaluate(element => {
        element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 760);
        element.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(900);

    await panel.evaluate((element, applicationId) => {
        const trace = {
            active: true,
            retainedVisibleFrames: 0,
            pendingWheelDelta: 0,
            visibleAnchor: null as HTMLElement | null,
            visibleAnchorTop: 0,
            maximumVisibleDeviation: 0,
            visibleAnchorSamples: 0,
            samples: [] as Array<{ scrollTop: number, scrollHeight: number, anchorTop: number | null, retained: string[] }>
        };
        (window as any).__nestedBoundaryTrace = trace;
        element.addEventListener('wheel', event => {
            if (trace.active) trace.pendingWheelDelta += (event as WheelEvent).deltaY;
        }, { passive: true, capture: true });
        const sample = () => {
            if (!trace.active) return;
            const viewport = element.getBoundingClientRect();
            if (trace.visibleAnchor?.isConnected && getComputedStyle(trace.visibleAnchor).visibility !== 'hidden') {
                const movement = trace.visibleAnchor.getBoundingClientRect().top - trace.visibleAnchorTop;
                trace.maximumVisibleDeviation = Math.max(trace.maximumVisibleDeviation,
                    Math.abs(movement + trace.pendingWheelDelta));
                trace.visibleAnchorSamples += 1;
            }
            trace.pendingWheelDelta = 0;
            const visibleRows = Array.from(element.querySelectorAll<HTMLElement>('[data-embed-nav-title="true"], .cm-line'))
                .map(row => ({ row, rect: row.getBoundingClientRect() }))
                .filter(({ row, rect }) => getComputedStyle(row).visibility !== 'hidden' &&
                    rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom)
                .sort((a, b) => Math.abs(a.rect.top - viewport.top - 120) - Math.abs(b.rect.top - viewport.top - 120));
            trace.visibleAnchor = visibleRows[0]?.row ?? null;
            trace.visibleAnchorTop = visibleRows[0]?.rect.top ?? 0;
            const retainedVisible = Array.from(element.querySelectorAll<HTMLElement>('[data-retained-widget-height]'))
                .some(widget => {
                    const rect = widget.getBoundingClientRect();
                    return rect.bottom > viewport.top && rect.top < viewport.bottom;
                });
            if (retainedVisible) trace.retainedVisibleFrames += 1;
            const anchor = element.querySelector<HTMLElement>(`[data-testid="embedded-editor-host-${applicationId}"]`)
                ?.closest<HTMLElement>('.cm-embedded-block-wrapper');
            trace.samples.push({
                scrollTop: element.scrollTop,
                scrollHeight: element.scrollHeight,
                anchorTop: anchor?.getBoundingClientRect().top ?? null,
                retained: Array.from(element.querySelectorAll<HTMLElement>('[data-retained-widget-height]'))
                    .map(widget => widget.dataset.retainedWidgetHeight || '')
            });
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }, application.id);

    for (let index = 0; index < 75; index += 1) {
        await page.mouse.wheel(0, -42);
        await page.waitForTimeout(12);
    }
    const result = await panel.evaluate(() => {
        const trace = (window as any).__nestedBoundaryTrace as {
            active: boolean;
            retainedVisibleFrames: number;
            maximumVisibleDeviation: number;
            visibleAnchorSamples: number;
            samples: Array<{ scrollTop: number, scrollHeight: number, anchorTop: number | null, retained: string[] }>;
        };
        trace.active = false;
        let maximumLayoutShift = 0;
        let maximumReverseJump = 0;
        let maximumEvent: unknown = null;
        for (let index = 1; index < trace.samples.length; index += 1) {
            const previous = trace.samples[index - 1];
            const current = trace.samples[index];
            maximumReverseJump = Math.max(maximumReverseJump, current.scrollTop - previous.scrollTop);
            if (previous.anchorTop !== null && current.anchorTop !== null) {
                const shift = Math.abs((current.anchorTop - previous.anchorTop) + (current.scrollTop - previous.scrollTop));
                if (shift > maximumLayoutShift) {
                    maximumLayoutShift = shift;
                    maximumEvent = { previous, current };
                }
            }
        }
        return { maximumLayoutShift, maximumReverseJump, retainedVisibleFrames: trace.retainedVisibleFrames,
            maximumVisibleDeviation: trace.maximumVisibleDeviation,
            visibleAnchorSamples: trace.visibleAnchorSamples, maximumEvent };
    });
    expect(result.retainedVisibleFrames, JSON.stringify(result)).toBe(0);
    expect(result.maximumReverseJump, JSON.stringify(result)).toBeLessThanOrEqual(2);
    // The application wrapper can be thousands of pixels above the viewport;
    // refining its off-screen document position is not itself a visible jump.
    // Judge the row under the user's eye against wheel intent instead. Event
    // delivery can differ by one 42 px step between consecutive paint samples.
    expect(result.visibleAnchorSamples).toBeGreaterThan(20);
    expect(result.maximumVisibleDeviation, JSON.stringify(result)).toBeLessThanOrEqual(44);
});
}

for (const font of [null, 'Arial', 'Times New Roman']) {
test(`promotes the clicked dormant nested editor while keeping its ancestry editable${font ? ` (${font})` : ''}`, async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:static-click-child-${suffix}`;
    const parentLabel = `test:static-click-parent-${suffix}`;
    const sourceLabel = `test:static-click-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Nested click child', label: childLabel, content: 'alpha beta gamma' }
    })).json();
    const parent = await (await page.request.post('/api/blocks', {
        data: { title: 'Nested click parent', label: parentLabel, content: `parent text\n[[${childLabel}∨]]` }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Nested click source', label: sourceLabel, content: `before\n[[${parentLabel}∨]]\nafter` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const parentHost = page.getByTestId(`embedded-editor-host-${parent.id}`);
    const childHost = page.getByTestId(`embedded-editor-host-${child.id}`);
    await expect(parentHost).toHaveAttribute('data-editor-mounted', 'true');
    await expect(childHost).toHaveAttribute('data-editor-mounted', 'true');
    await expect(childHost.locator('[data-editor-dormant="true"]').first()).toBeVisible();
    if (font) {
        await page.addStyleTag({ content: `:root { --font-sans: "${font}"; }` });
    }
    const mountedBefore = await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').count();
    const line = childHost.locator('.cm-line').filter({ hasText: 'alpha beta gamma' });
    // A fixed x=48 falls on different characters in Palatino and the system
    // serif fallbacks. Click the leading quarter of the actual "b" glyph so
    // the expected native caret is before "beta" on every platform.
    const point = await line.evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        while ((text = walker.nextNode())) {
            const offset = text.textContent?.indexOf('beta') ?? -1;
            if (offset < 0) continue;
            const range = document.createRange();
            range.setStart(text, offset);
            range.setEnd(text, offset + 1);
            const glyph = range.getBoundingClientRect();
            const row = element.getBoundingClientRect();
            return { x: glyph.left - row.left + glyph.width / 4, y: (glyph.top + glyph.bottom) / 2 - row.top };
        }
        throw new Error('Missing beta text in the dormant editor');
    });
    await line.click({ position: point });

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    // Promotion reuses the existing view rather than adding another editor.
    await expect(panel.locator('.cm-content')).toHaveCount(mountedBefore);
    await expect(childHost).toHaveAttribute('data-editor-activated', 'true');
    await expect(parentHost).toHaveAttribute('data-editor-activated', 'true');
    await expect(childHost.locator('[data-editor-wants-focus="true"]')).toBeVisible();
    const focusedEditor = childHost.locator('.cm-content:focus');
    await expect(focusedEditor).toContainText('alpha beta gamma');
    await page.keyboard.insertText('X');
    await expect(focusedEditor).toContainText('alpha Xbeta gamma');
});
}

test('maps a warm formatted click through the existing CodeMirror view', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:static-native-point-target-${suffix}`;
    const sourceLabel = `test:static-native-point-source-${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: { title: 'Static native point target', label: targetLabel, content: 'prefix **bold** suffix' }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Static native point source',
            label: sourceLabel,
            content: `${Array.from({ length: 220 }, (_, index) => `line ${index}`).join('\n')}\n[[${targetLabel}∨]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(rootEditor).toContainText('line 0');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    await panel.evaluate(async element => {
        const bottom = element.scrollHeight - element.clientHeight;
        for (let step = 1; step <= 8; step += 1) {
            element.scrollTop = bottom * (step / 8);
            element.dispatchEvent(new Event('scroll'));
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        (window as any).__staticNativePointScrollTimer = window.setInterval(() => element.dispatchEvent(new Event('scroll')), 40);
    });
    const host = page.getByTestId(`embedded-editor-host-${target.id}`);
    await expect(host).toBeVisible();
    await expect(host).toHaveAttribute('data-editor-phase', 'warm');
    const bold = host.locator('.cm-format-bold').filter({ hasText: 'bold' });
    await expect(bold).toBeVisible();
    const geometryBefore = await host.evaluate(element => {
        const panel = element.closest<HTMLElement>('[role="tabpanel"]')!;
        return { top: element.getBoundingClientRect().top, scrollTop: panel.scrollTop };
    });
    await bold.click({ position: { x: 1, y: 8 } });
    await page.evaluate(() => {
        window.clearInterval((window as any).__staticNativePointScrollTimer);
        delete (window as any).__staticNativePointScrollTimer;
    });

    await expect(host).toHaveAttribute('data-editor-mounted', 'true');
    await expect(host).toHaveAttribute('data-editor-activated', 'true');
    const geometryAfter = await host.evaluate(element => {
        const panel = element.closest<HTMLElement>('[role="tabpanel"]')!;
        return { top: element.getBoundingClientRect().top, scrollTop: panel.scrollTop };
    });
    expect(Math.abs(geometryAfter.top - geometryBefore.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometryAfter.scrollTop - geometryBefore.scrollTop)).toBeLessThanOrEqual(1);
    const focusedEditor = host.locator('.cm-content:focus');
    await expect(focusedEditor).toBeVisible();
    await page.keyboard.insertText('X');
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${target.id}`)).json()).content)
        .toBe('prefix **Xbold** suffix');
});

test('preserves a drag selection that begins in a dormant embedded editor', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:dormant-drag-child-${suffix}`;
    const sourceLabel = `test:dormant-drag-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Dormant drag child', label: childLabel, content: 'alpha beta gamma delta epsilon' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Dormant drag source', label: sourceLabel, content: `[[${childLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const host = page.getByTestId(`embedded-editor-host-${child.id}`);
    await expect(host).toHaveAttribute('data-editor-phase', 'warm');
    const line = host.locator('.cm-line').first();
    const box = await line.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 8, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + Math.min(190, box!.width - 8), box!.y + box!.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(host).toHaveAttribute('data-editor-phase', 'hot');
    await expect(host.locator('.cm-selectionBackground')).not.toHaveCount(0);
    await expect(host.locator('.cm-content:focus')).toHaveCount(1);
});

test('keeps an embedded editor focused after a text drag ends on workspace background', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:background-drag-child-${suffix}`;
    const sourceLabel = `test:background-drag-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Background drag child', label: childLabel, content: 'alpha beta gamma delta epsilon' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Background drag source', label: sourceLabel, content: `before\n[[${childLabel}∨]]\nafter` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /^Search\b/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const host = page.getByTestId(`embedded-editor-host-${child.id}`);
    const line = host.locator('.cm-line').first();
    const lineBox = await line.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(lineBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    const y = lineBox!.y + lineBox!.height / 2;
    const backgroundX = panelBox!.x + panelBox!.width - 4;
    expect(await page.evaluate(({ x, y }) =>
        !!document.elementFromPoint(x, y)?.closest('[data-block-root]'), { x: backgroundX, y })).toBe(false);
    await panel.evaluate(element => {
        (window as typeof window & { __backgroundDragClicks?: number }).__backgroundDragClicks = 0;
        element.addEventListener('click', event => {
            const target = event.target;
            if (target instanceof Element && !target.closest('[data-block-root]')) {
                (window as typeof window & { __backgroundDragClicks?: number }).__backgroundDragClicks!++;
            }
        }, true);
    });

    await page.mouse.move(lineBox!.x + 20, y);
    await page.mouse.down();
    await page.mouse.move(lineBox!.x + 160, y, { steps: 5 });
    await page.mouse.move(backgroundX, y, { steps: 8 });
    await page.mouse.up();

    expect(await page.evaluate(() => (window as typeof window & { __backgroundDragClicks?: number }).__backgroundDragClicks)).toBe(1);
    await expect(host.locator('.cm-content:focus')).toHaveCount(1);
    await expect(host.locator('[data-editor-wants-focus="true"]')).toHaveCount(1);
    const selectedText = await host.locator('.cm-content').first().evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        const view = EditorView.findFromDOM(element.closest('.cm-editor')!);
        const selection = view.state.selection.main;
        return view.state.sliceDoc(selection.from, selection.to);
    });
    expect(selectedText.length).toBeGreaterThan(0);
    await page.mouse.click(backgroundX, y);
    await expect(panel.locator('.cm-content:focus')).toHaveCount(0);
});

test('limits Fira ligatures to four prose operators and keeps raw math literal', async ({ page }) => {
    const editor = await openEditor(page);
    const source = String.raw`~> <=> => <= != \/ := |> $~> <=> => <= != \/ := |>$`;
    await replaceEditorText(page, editor, source);
    await editor.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        const view = EditorView.findFromDOM(element.closest('.cm-editor')!);
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('$') + 2 } });
    });

    await expect(editor.locator('.cm-math-editing')).toBeVisible();
    await expect.poll(() => editor.locator('.cm-ligature').allTextContents())
        .toEqual(['~>', '<=>', '=>', '<=']);
    const features = await editor.evaluate(element => {
        const prose = element.querySelector('.cm-ligature')!;
        const math = element.querySelector('.cm-math-editing')!;
        return {
            prose: getComputedStyle(prose).fontFeatureSettings,
            math: getComputedStyle(math).fontFeatureSettings,
            mathFont: getComputedStyle(math).fontFamily
        };
    });
    expect(features.prose).toMatch(/^"calt"(?: 1)?$/);
    expect(features.math).toContain('"calt" 0');
    expect(features.mathFont).toContain('Fira Code');
});

test('uses the final CodeMirror formatting model in dormant embedded editors', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:static-format-target-${suffix}`;
    const sourceLabel = `test:static-format-source-${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Static formatting target',
            label: targetLabel,
            content: '**bold** *italic* _underlined_ [linked](https://example.com)\n* item\n> quoted $x^2$'
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Static formatting source', label: sourceLabel, content: `[[${targetLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const host = page.getByTestId(`embedded-editor-host-${target.id}`);
    await expect(host).toHaveAttribute('data-editor-mounted', 'true');
    await expect(host.locator('[data-editor-dormant="true"]').first()).toBeVisible();
    await expect(host.locator('.cm-format-bold')).toHaveCSS('font-weight', /700|bold/);
    await expect(host.locator('.cm-format-italic')).toHaveCSS('font-style', 'italic');
    await expect(host.locator('.cm-underline-run')).toHaveCSS('border-bottom-width', '1px');
    await expect(host.locator('.cm-markdown-link')).toHaveAttribute('href', 'https://example.com');
    await expect(host).toContainText('quoted');
    await expect(host.locator('.cm-math-inline .katex')).toBeVisible();
    await expect(host).not.toContainText('**bold**');
});

test('expands the live editor grid without overlapping content after display math', async ({ page }) => {
    const suffix = Date.now();
    const proofLabel = `test:grid-proof-${suffix}`;
    const targetLabel = `test:grid-target-${suffix}`;
    const sourceLabel = `test:grid-source-${suffix}`;
    const proof = await (await page.request.post('/api/blocks', {
        data: { title: 'proof', label: proofLabel, content: 'proof content' }
    })).json();
    const target = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Grid target',
            label: targetLabel,
            content: `\\[\n\\Delta u = f,\\qquad u|_{\\partial D}=g\n\\]\nWe would now take $D$ to be the unit disk.\n[[@${proofLabel}∨]]`
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Grid source', label: sourceLabel, content: `[[${targetLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const host = page.getByTestId(`embedded-editor-host-${target.id}`);
    await expect(host).toHaveAttribute('data-editor-mounted', 'true');
    await expect(host.locator('.embedded-editor-live > [data-editor-dormant="true"]').first()).toBeVisible();
    await host.locator('.cm-math-block').first().click();
    await expect(host).toHaveAttribute('data-editor-activated', 'true');
    const live = host.locator('.embedded-editor-live').first();
    await expect(live.locator('.cm-math-editing').first()).toBeVisible();
    await expect(live.getByTestId(`standout-label-${proof.id}`)).toBeAttached();
    const layout = await live.evaluate((element, proofId) => {
        const title = element.querySelector<HTMLElement>(`[data-testid="standout-label-${proofId}"]`)?.closest<HTMLElement>('[data-embed-nav-title="true"]')
            || element.querySelector<HTMLElement>('[data-embed-nav-title="true"]');
        const editing = Array.from(element.querySelectorAll<HTMLElement>('.cm-math-editing'));
        if (!title || editing.length === 0) return null;
        const titleRect = title.getBoundingClientRect();
        const mathBottom = Math.max(...editing.map(item => item.getBoundingClientRect().bottom));
        const editorHost = element.closest<HTMLElement>('[data-editor-mounted="true"]')!;
        return {
            mathBottom,
            titleTop: titleRect.top,
            stackHeight: editorHost.getBoundingClientRect().height,
            liveHeight: element.getBoundingClientRect().height
        };
    }, proof.id);
    expect(layout).not.toBeNull();
    expect(layout!.mathBottom).toBeLessThanOrEqual(layout!.titleTop + 1);
    expect(layout!.stackHeight).toBeGreaterThanOrEqual(layout!.liveHeight - 1);
});

test('demotes inactive sibling editors while preserving their undo history', async ({ page }) => {
    const suffix = Date.now();
    const firstLabel = `test:pooled-first-${suffix}`;
    const secondLabel = `test:pooled-second-${suffix}`;
    const sourceLabel = `test:pooled-source-${suffix}`;
    const first = await (await page.request.post('/api/blocks', {
        data: { title: 'First pooled target', label: firstLabel, content: 'first content' }
    })).json();
    const second = await (await page.request.post('/api/blocks', {
        data: { title: 'Second pooled target', label: secondLabel, content: 'second content' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Pooled source', label: sourceLabel, content: `[[${firstLabel}∨]]\n[[${secondLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const firstHost = page.getByTestId(`embedded-editor-host-${first.id}`);
    const secondHost = page.getByTestId(`embedded-editor-host-${second.id}`);
    await expect(firstHost).toHaveAttribute('data-editor-mounted', 'true');
    await expect(secondHost).toHaveAttribute('data-editor-mounted', 'true');
    await firstHost.locator('.cm-line').click({ position: { x: 45, y: 8 } });
    let focused = page.locator('.cm-content:focus');
    await expect(focused).toContainText('first content');
    await page.keyboard.insertText('X');
    await expect(focused).toHaveText('first coXntent');

    await secondHost.locator('.cm-line').click({ position: { x: 45, y: 8 } });
    await expect(page.locator('[data-editor-activated="true"] .cm-editor')).toHaveCount(1);
    await expect(firstHost.locator('[data-editor-dormant="true"]')).toBeVisible();

    await firstHost.locator('.cm-line').click({ position: { x: 45, y: 8 } });
    focused = page.locator('.cm-content:focus');
    await expect(focused).toHaveText('first coXntent');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(focused).toHaveText('first content');
    await expect(page.locator('[data-editor-activated="true"] .cm-editor')).toHaveCount(1);
});

test('keeps repeated occurrences distinct while sharing edits and toggle geometry', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:repeated-child-${suffix}`;
    const sharedLabel = `test:repeated-shared-${suffix}`;
    const sourceLabel = `test:repeated-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Repeated child', label: childLabel, content: 'child body line one\nchild body line two' }
    })).json();
    const shared = await (await page.request.post('/api/blocks', {
        data: { title: 'Repeated shared block', label: sharedLabel, content: `shared text\n[[${childLabel}∨]]\nshared tail` }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Repeated source', label: sourceLabel, content: `[[${sharedLabel}∨]]\nbetween\n[[${sharedLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const occurrences = page.getByTestId(`embedded-editor-host-${shared.id}`);
    await expect(occurrences).toHaveCount(2);
    const occurrenceKeys = await occurrences.evaluateAll(elements => elements.map(element => element.getAttribute('data-occurrence-key')));
    expect(new Set(occurrenceKeys).size).toBe(2);

    const first = occurrences.nth(0);
    const second = occurrences.nth(1);
    await expect(first).toHaveAttribute('data-editor-phase', 'warm');
    await expect(second).toHaveAttribute('data-editor-phase', 'warm');
    await first.locator('.cm-line').filter({ hasText: 'shared text' }).click({ position: { x: 80, y: 8 } });
    await expect(first).toHaveAttribute('data-editor-phase', 'hot');
    await expect(second).toHaveAttribute('data-editor-phase', 'warm');

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.insertText('X');
    await expect(second).toContainText('Xshared text');

    const heightsBefore = await occurrences.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    await first.locator('[data-embed-nav-title="true"]').filter({ hasText: 'Repeated child' }).first().click();
    await expect(first).not.toContainText('child body line one');
    await expect(second).not.toContainText('child body line one');
    await expect.poll(async () => {
        const heights = await occurrences.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
        return heights.length === 2 && heights.every((height, index) => height < heightsBefore[index] - 10);
    }).toBe(true);
    const heightsAfter = await occurrences.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    expect(heightsAfter[0]).toBeLessThan(heightsBefore[0] - 10);
    expect(heightsAfter[1]).toBeLessThan(heightsBefore[1] - 10);

    await second.locator('.cm-line').filter({ hasText: 'Xshared text' }).click({ position: { x: 60, y: 8 } });
    await expect(second).toHaveAttribute('data-editor-phase', 'hot');
    await expect(first).toHaveAttribute('data-editor-phase', 'warm');
    await expect(page.locator('[data-editor-phase="hot"]')).toHaveCount(1);
});

test('preserves an intentional upward scroll while several open embeds finish loading', async ({ page }) => {
    const suffix = Date.now();
    const targetLabels = [1, 2, 3].map(index => `test:upward-scroll-target-${index}-${suffix}`);
    for (const [index, label] of targetLabels.entries()) {
        await page.request.post('/api/blocks', {
            data: {
                title: `Upward scroll target ${index + 1}`,
                label,
                content: Array.from({ length: 4 }, (_, line) => `target ${index + 1} line ${line}`).join('\n')
            }
        });
    }
    const sourceLabel = `test:upward-scroll-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Three open embeds',
            label: sourceLabel,
            content: `${Array.from({ length: 120 }, (_, index) => `source line ${index}`).join('\n')}\n${targetLabels.map(label => `[[${label}∨]]`).join('\n')}\n${Array.from({ length: 8 }, (_, index) => `tail line ${index}`).join('\n')}`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    await expect(panel.locator('.cm-content').first()).toContainText('source line 0');
    // Opening a search result is asynchronous. Scrolling the previous note's
    // short panel cannot bring the new source's distant embeds into view.
    await panel.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
    });
    const hosts = panel.locator('[data-testid^="embedded-editor-host-"]');
    await expect(hosts).toHaveCount(3);
    await expect(hosts.first()).toContainText('target 1 line 0');

    const requestedScrollTop = await panel.evaluate(element => {
        const next = Math.max(0, element.scrollTop - 180);
        element.scrollTop = next;
        element.dispatchEvent(new Event('scroll'));
        return next;
    });
    await expect.poll(() => panel.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100);
    await hosts.first().evaluate(element => {
        const host = element as HTMLElement;
        host.style.minHeight = `${host.getBoundingClientRect().height + 300}px`;
    });
    await page.waitForTimeout(500);
    const finalDistanceFromBottom = await panel.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    expect(finalDistanceFromBottom).toBeGreaterThan(80);
    expect(await panel.evaluate(element => element.scrollTop)).toBeGreaterThanOrEqual(requestedScrollTop - 2);
});
