import { expect, test } from 'playwright/test';
import { isTikzCdMath } from '../src/lib/editor/tikz-cd-renderer';

test('routes only a complete standalone tikzcd environment', () => {
    expect(isTikzCdMath('\\begin{tikzcd}A & B\\end{tikzcd}')).toBe(true);
    expect(isTikzCdMath('\\begin{tikzcd}[row sep=large]\nA & B\n\\end{tikzcd}')).toBe(true);
    expect(isTikzCdMath('x + \\begin{tikzcd}A\\end{tikzcd}')).toBe(false);
    expect(isTikzCdMath('\\begin{tikzcd}A')).toBe(false);
    expect(isTikzCdMath('\\begin{CD}A @>>> B\\end{CD}')).toBe(false);
});

test('browser TeX engine renders tikzcd under the strict renderer content policy', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const frame = document.createElement('iframe');
        frame.src = '/tikz-renderer.html';
        document.body.appendChild(frame);
        return await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('diagram render timed out')), 70_000);
            window.addEventListener('message', function onMessage(event) {
                if (event.source !== frame.contentWindow || !event.data?.mathNoteTikz) return;
                if (event.data.ready) {
                    frame.contentWindow?.postMessage({ mathNoteTikz: true, id: 1,
                        source: String.raw`\begin{tikzcd}
  A & B \\
  C & D
  \arrow["f", from=1-1, to=1-2]
  \arrow["g"', from=1-1, to=2-1]
\end{tikzcd}` }, '*');
                } else if (event.data.svg) {
                    clearTimeout(timeout);
                    window.removeEventListener('message', onMessage);
                    resolve(event.data.svg);
                }
            });
        });
    });
    expect(result).toContain('<svg');
});

test('routes only tikzcd display math to the diagram renderer', async ({ page, request }) => {
    test.setTimeout(90_000);
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill('Before $x^2$\n\\[\n\\begin{tikzcd}A \\arrow[r, "f"] & B\\end{tikzcd}\n\\]\nAfter');
    await page.getByLabel('Open settings').click();
    const diagram = page.locator('.cm-math-block.cm-math-rendered .cm-tikzcd-image');
    await expect(diagram).toBeVisible({ timeout: 30_000 });
    const svg = await diagram.evaluate(image => decodeURIComponent((image as HTMLImageElement).src.split(',')[1]));
    expect(svg).toContain('@font-face{font-family:cmmi10;');
    expect(svg).toContain('data:font/ttf;base64,');
    await expect(page.locator('.cm-math-inline .katex')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => diagram.evaluate(image => image.getBoundingClientRect().width)).toBeGreaterThan(100);
    await diagram.click();
    await expect(editor).toContainText('\\begin{tikzcd}');
    await expect(page.locator('.cm-math-block .cm-tikzcd-image')).toBeVisible();
});

test('keeps diagrams rendered in a locked embedded note', async ({ page, request }) => {
    test.setTimeout(90_000);
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    const child = await (await request.post('/api/blocks', { data: {
        title: 'Diagram child', label: 'test:diagram-child',
        content: '\\[\n\\begin{tikzcd}A \\arrow[r] & B\\end{tikzcd}\n\\]'
    } })).json();
    const root = await (await request.post('/api/blocks', { data: {
        title: 'Diagram parent', label: 'test:diagram-parent', content: '[[test:diagram-child∨]]'
    } })).json();
    await page.goto('/');
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(root.label);
    await search.press('Enter');
    const childEditor = page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-editor').first();
    await expect(childEditor.locator('.cm-tikzcd-image')).toBeVisible({ timeout: 30_000 });
    await page.locator(`[data-testid="block-metadata-header-${root.id}"]`).click();
    await page.getByTitle('Lock for view-only').click();
    await childEditor.locator('.cm-tikzcd-image').click();
    await expect(childEditor.locator('.cm-tikzcd-image')).toBeVisible();
    await expect(childEditor.locator('.cm-math-editing')).toHaveCount(0);
});
