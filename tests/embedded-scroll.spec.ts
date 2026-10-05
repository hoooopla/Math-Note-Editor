import { expect, test } from 'playwright/test';

test('keeps registered ancestors hot when navigation promotes a child before it loads', async ({ page }) => {
    await page.goto('/');
    const phases = await page.evaluate(async () => {
        const moduleUrl = '/src/lib/embedded-editor-lifecycle.ts';
        const { registerEmbeddedOccurrence, promoteEmbeddedOccurrence, initialEmbeddedEditorPhase,
            demoteEmbeddedOccurrence, resetEmbeddedEditorLifecycle } = await import(moduleUrl);
        resetEmbeddedEditorLifecycle();
        const panel = document.createElement('div');
        panel.setAttribute('role', 'tabpanel');
        const parentHost = document.createElement('div');
        const childHost = document.createElement('div');
        panel.append(parentHost, childHost);
        document.body.append(panel);
        const parent = JSON.stringify(['test-root', 'middle@0']);
        const child = JSON.stringify(['test-root', 'middle@0', 'leaf@0']);
        // Both can be promoted before registration, as occurs during loading.
        promoteEmbeddedOccurrence(parent);
        const releaseParent = registerEmbeddedOccurrence(parent, parentHost);
        promoteEmbeddedOccurrence(child);
        const before = [initialEmbeddedEditorPhase(parent), initialEmbeddedEditorPhase(child)];
        const releaseChild = registerEmbeddedOccurrence(child, childHost);
        const after = [initialEmbeddedEditorPhase(parent), initialEmbeddedEditorPhase(child)];
        promoteEmbeddedOccurrence(parent);
        const returned = [initialEmbeddedEditorPhase(parent), initialEmbeddedEditorPhase(child)];
        demoteEmbeddedOccurrence(parent);
        releaseChild();
        releaseParent();
        panel.remove();
        resetEmbeddedEditorLifecycle();
        return { before, after, returned };
    });
    expect(phases.before).toEqual(['hot', 'hot']);
    expect(phases.after).toEqual(['hot', 'hot']);
    expect(phases.returned).toEqual(['hot', 'warm']);
});

test('continues the wheel gesture from the actual position after content height clamps scrolling', async ({ page }) => {
    await page.goto('/');
    const movement = await page.evaluate(async () => {
        const moduleUrl = '/src/lib/embedded-scroll-coordinator.ts';
        const { registerEmbeddedPanelScrollGuard } = await import(moduleUrl);
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'fixed', top: '0', left: '0', width: '300px', height: '200px',
            overflow: 'auto', overflowAnchor: 'none'
        });
        const content = document.createElement('div');
        content.style.height = '3000px';
        panel.append(content);
        document.body.append(panel);
        const release = registerEmbeddedPanelScrollGuard(panel);
        const wheelUp = () => panel.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
        try {
            panel.scrollTop = 2500;
            panel.dispatchEvent(new Event('scroll'));
            wheelUp();
            panel.scrollTop -= 40;
            panel.dispatchEvent(new Event('scroll'));

            // A recycled viewport can temporarily reduce the scroll range.
            // The browser clamps the requested old position to the new bottom.
            content.style.height = '1200px';
            const clamped = panel.scrollTop;
            panel.dispatchEvent(new Event('scroll'));
            content.style.height = '3000px';
            wheelUp();
            panel.scrollTop -= 40;
            panel.dispatchEvent(new Event('scroll'));
            return { clamped, afterNextWheel: panel.scrollTop };
        } finally {
            release();
            panel.remove();
        }
    });
    expect(movement.clamped).toBe(1000);
    expect(movement.afterNextWheel).toBe(960);
});
