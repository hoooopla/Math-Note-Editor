import { expect, test } from 'playwright/test';
import { isTikzCdMath, tikzMacroDefinitions } from '../src/lib/editor/tikz-cd-renderer';

test('routes only a complete standalone tikzcd environment', () => {
    expect(isTikzCdMath('\\begin{tikzcd}A & B\\end{tikzcd}')).toBe(true);
    expect(isTikzCdMath('\\begin{tikzcd}[row sep=large]\nA & B\n\\end{tikzcd}')).toBe(true);
    expect(isTikzCdMath('x + \\begin{tikzcd}A\\end{tikzcd}')).toBe(false);
    expect(isTikzCdMath('\\begin{tikzcd}A')).toBe(false);
    expect(isTikzCdMath('\\begin{CD}A @>>> B\\end{CD}')).toBe(false);
});

test('converts compatible KaTeX macro expansions to TeX definitions', () => {
    expect(tikzMacroDefinitions({
        '\\Q': '\\mathbb{Q}',
        '\\pair': '\\langle #1 \\rangle',
        '\\nested': '\\pair{#1}',
        '\\bad': '{unclosed',
        '\\alsoBad': 'comment % text'
    })).toBe(String.raw`\def\Q{\mathbb{Q}}
\def\nested#1{\pair{#1}}
\def\pair#1{\langle #1 \rangle}`);
});

test('saved macros render in diagram nodes and labels and updates invalidate the image cache', async ({ page, request }) => {
    test.setTimeout(120_000);
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    expect((await request.post('/api/settings', { data: {
        macros: {
            '\\Q': '\\mathbb{Q}',
            '\\pair': '\\langle #1 \\rangle',
            '\\nested': '\\pair{\\mathcal{#1}}'
        },
        emptySetStyle: 'slanted'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill(String.raw`\[
\begin{tikzcd}
\Q \arrow[r, "\nested{A}"] & \emptyset \arrow[d, "\pair{B}"] \\
\operatorname{Hom}(\Q,\emptyset) & \Q
\end{tikzcd}
\]`);
    await page.getByLabel('Open settings').click();
    const diagram = page.locator('.cm-math-block.cm-math-rendered .cm-tikzcd-image');
    await expect(diagram).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => diagram.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const svg = await diagram.evaluate(image => decodeURIComponent((image as HTMLImageElement).src.split(',')[1]));
    expect(svg).toContain('<svg');
    expect(svg).toContain('msbm10');
    const images = await page.evaluate(async () => {
        const modulePath = '/src/lib/editor/tikz-cd-renderer.ts';
        const renderer = await import(/* @vite-ignore */ modulePath);
        const source = String.raw`\begin{tikzcd}\testmacro\end{tikzcd}`;
        return Promise.all([
            renderer.renderTikzCd(source, {'\\testmacro': 'A'}),
            renderer.renderTikzCd(source, {'\\testmacro': 'B'})
        ]);
    });
    expect(images[0]).not.toBe(images[1]);
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

test('renders a commutativity symbol on a phantom diagonal arrow', async ({ page, request }) => {
    test.setTimeout(90_000);
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`\[
\begin{tikzcd}
\cdots \arrow[r] & E^{n-1} \arrow[r, "\partial"] \arrow[d, "f^{n-1}"] \arrow[dr, phantom, "\circlearrowright"] & E^n \arrow[r, "\partial"] \arrow[d, "f^n"] & E^{n+1} \arrow[r] \arrow[d, "f^{n+1}"] & \cdots \\
\cdots \arrow[r] & F^{n-1} \arrow[r, "\partial"] & F^n \arrow[r, "\partial"] & F^{n+1} \arrow[r] & \cdots
\end{tikzcd}
\]`);
    await page.getByLabel('Open settings').click();
    const diagram = page.locator('.cm-math-block.cm-math-rendered .cm-tikzcd-image');
    await expect(diagram).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => diagram.evaluate(image => (image as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    const svg = await diagram.evaluate(image => decodeURIComponent((image as HTMLImageElement).src.split(',')[1]));
    expect(svg).toContain('font-family="msam10"');
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
    await page.getByRole('button', { name: 'Search', exact: true }).click();
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
