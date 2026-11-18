import { expect, test } from 'playwright/test';
import katex from 'katex';
import { mathRenderDiagnostic } from '../src/lib/editor/math-render-error';
import { recoveryCandidates } from '../src/lib/editor/math-recovery';

test('KaTeX errors identify their source range only when it maps to the typed formula', () => {
    const source = String.raw`x + \notACommand`;
    let error: unknown;
    try { katex.renderToString(source, { throwOnError: true }); }
    catch (reason) { error = reason; }
    expect(error).toBeInstanceOf(katex.ParseError);
    const diagnostic = mathRenderDiagnostic(error, source, 'katex');
    expect(diagnostic.message).toContain('Undefined control sequence');
    expect(diagnostic.excerpt?.error).toBe(String.raw`\notACommand`);
    expect(diagnostic.sourceRange).toEqual({ from: 4, to: source.length });
    expect(mathRenderDiagnostic(error, source, 'katex', false).excerpt).toBeUndefined();
});

test('finds a nested matrix cell without splitting outer alignment rows', () => {
    const source = String.raw`\begin{align*}a &= b+c\\ d &= e+f\\ \begin{matrix}fe & f^\end{matrix}\end{align*}`;
    expect(recoveryCandidates(source).map(range => source.slice(range.from, range.to))).toContain('f^');
});

test('keeps valid alignment rows and isolates a broken matrix cell', async ({ page, request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill(String.raw`\[
\begin{align*}
a &= b+c\\
d &= e+f\\
\begin{matrix}fe & f^\end{matrix}
\end{align*}
\]`);
    await page.getByLabel('Open settings').click();
    const recovered = page.locator('.cm-math-block.cm-math-rendered .cm-math-recovered-fragment');
    await expect(recovered).toBeVisible();
    await expect(recovered.locator('code')).toHaveText('f^');
    await expect(page.locator('.cm-math-block.cm-math-rendered .katex-html')).toContainText('a');
    await expect(page.locator('.cm-math-block.cm-math-rendered .katex-html')).toContainText('d');
    await expect(page.locator('.cm-math-recovered-note')).toContainText(/^Error: .*superscript/);
    await expect.poll(async () => {
        const row = await page.locator('.cm-math-partial-row').first().boundingBox();
        const formula = await page.locator('.cm-math-partial-row .katex-display').first().boundingBox();
        const note = await page.locator('.cm-math-recovered-note').first().boundingBox();
        return row && formula && note ? note.y >= formula.y + formula.height && Math.abs(note.x - row.x) <= 2 : false;
    }).toBe(true);
    await page.keyboard.press('Escape');
    await recovered.click();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('f^');
});

test('recovers a broken cell in cases and array environments', async ({ page, request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill(String.raw`\[
\begin{cases} x & x>0\\ f^ & x\le 0 \end{cases}
\]
\[
\begin{array}{cc} a & b\\ c & d^ \end{array}
\]`);
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-recovered-fragment code')).toHaveText(['f^', 'd^']);
    await expect(page.locator('.cm-math-block.cm-math-rendered .katex-html')).toHaveCount(2);
});

test('keeps a valid prefix outside an environment', async ({ page, request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill(String.raw`\[a+b+\frac{1}{\]`);
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-recovered-fragment code')).toHaveText(String.raw`\frac{1}{`);
    await expect(page.locator('.cm-math-block.cm-math-rendered .katex-html')).toContainText('a');
});

test('unknown commands render alongside valid math while malformed structure keeps its error', async ({ page, request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill(String.raw`Before $x+\notACommand+\otherBad+y$ after
\[
x + \notACommand
\]
\[
\frac{1}{
\]`);
    await page.getByLabel('Open settings').click();
    const inline = page.locator('.cm-math-inline.cm-math-partial');
    const blockPartial = page.locator('.cm-math-block.cm-math-partial');
    await expect(inline.locator('.katex-html')).toContainText(String.raw`\notACommand`);
    await expect(inline.locator('.cm-math-partial-note')).toHaveText('(unknown command)');
    await expect(inline.locator('.cm-math-unknown-command')).toHaveText([
        String.raw`\notACommand`, String.raw`\otherBad`
    ]);
    await expect(blockPartial.locator('.katex-html')).toContainText(String.raw`x+\notACommand`);
    await expect(blockPartial.locator('.cm-math-partial-row .cm-math-partial-note'))
        .toHaveText(String.raw`Error: Undefined control sequence: \notACommand`);
    await expect.poll(async () => {
        const row = await blockPartial.locator('.cm-math-partial-row').boundingBox();
        const formula = await blockPartial.locator('.katex-display').boundingBox();
        const note = await blockPartial.locator('.cm-math-partial-note').boundingBox();
        return row && formula && note ? note.y >= formula.y + formula.height && Math.abs(note.x - row.x) <= 2 : false;
    }).toBe(true);
    await expect(blockPartial.locator('.cm-math-unknown-command')).toHaveText(String.raw`\notACommand`);
    const blockError = page.locator('.cm-math-block.cm-math-rendered .cm-math-render-error-block');
    await expect(blockError).toBeVisible();
    await expect(blockError.locator('.cm-math-render-error-message')).toContainText('end of input');
    await page.keyboard.press('Escape');
    await blockPartial.click();
    await expect(editor.locator('.cm-math-editing').filter({ hasText: String.raw`\notACommand` })).toBeVisible();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(String.raw`\notACommand`);
    await expect(page.locator('.cm-math-block .cm-math-partial-note')).toBeVisible();
});

test('failed diagrams show a local error without claiming a source location', async ({ page, request }) => {
    test.setTimeout(90_000);
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill(String.raw`\[
\begin{tikzcd}A \arrow[r, "\notACommand"] & B\end{tikzcd}
\]`);
    await page.getByLabel('Open settings').click();
    const error = page.locator('.cm-math-block.cm-math-rendered .cm-math-render-error-block');
    await expect(error).toBeVisible({ timeout: 35_000 });
    await expect(error).toContainText('Diagram could not compile');
    await expect(error).toContainText('did not report an exact location');
    await expect(error.locator('.cm-math-render-error-excerpt')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await error.click();
    await expect(editor.locator('.cm-math-editing').filter({ hasText: String.raw`\notACommand` })).toBeVisible();
    await expect(page.locator('.cm-math-block .cm-math-render-error-block')).toBeVisible({ timeout: 35_000 });
});
