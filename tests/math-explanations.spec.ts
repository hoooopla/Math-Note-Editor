import { expect, test } from 'playwright/test';
import { maskMathExplanations, parseMathExplanations, prepareExplainedMath } from '../src/lib/editor/math-tooltip-syntax';

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

test('parses balanced arguments without exposing explanation delimiters', () => {
    const source = String.raw`$a \tooltip{\frac{x}{y}}{Proof with $z$ and \[q\] and {nested}} b$`;
    const parsed = parseMathExplanations(source);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].math).toBe(String.raw`\frac{x}{y}`);
    expect(parsed[0].content).toContain(String.raw`\[q\]`);
    expect(maskMathExplanations(source)).not.toContain('$z$');
    expect(maskMathExplanations(String.raw`plain \tooltip{x}{$z$}`)).toContain('$z$');
    expect(prepareExplainedMath(source).tex).toContain(String.raw`\htmlData{math-tooltip-id=`);
    expect(parseMathExplanations(String.raw`\tooltip{\le}{unfinished`)).toHaveLength(0);
});

test('completes a tooltip with the cursor in the math argument', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('$x$');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.insertText('\\tool');
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    await page.locator('.cm-tooltip-autocomplete li').filter({ hasText: '\\tooltip' }).first().click();
    await expect(editor).toContainText(String.raw`\tooltip{}{}`);
    await page.keyboard.insertText('=');
    await page.keyboard.press('Tab');
    await page.keyboard.insertText('because');
    await expect(editor).toContainText(String.raw`\tooltip{=}{because}`);
});

test('opens inline explanations with math and closes them by click or Escape', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill(String.raw`Before $a \tooltip{\le}{By $x^2$ and \[\frac{1}{2}\].} b$ after`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const target = page.locator('.cm-math-explanation-trigger').first();
    await expect(target).toBeVisible();
    await target.click();
    const card = page.locator('.math-explanation-popover');
    await expect(card).toBeVisible();
    await expect(card).toContainText('By');
    await expect(card.locator('.katex')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await target.click();
    await expect(card).toBeVisible();
    await target.click();
    await expect(card).toHaveCount(0);
    await target.click();
    await expect(card).toBeVisible();
    await page.getByRole('tablist').click({ position: { x: 5, y: 5 } });
    await expect(card).toHaveCount(0);
    await target.click();
    await expect(card).toBeVisible();
    await card.getByLabel('Open explanation in tab').click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Explanation:/ })).toBeVisible();
    await expect(page.locator('[id^="explanation-tab-panel-"][aria-hidden="false"]')).toContainText('By');
});

test('opens a read-only lemma preview from a display-math explanation', async ({ page, request }) => {
    const lemma = await request.post('/api/blocks', {
        data: { title: 'Cauchy lemma', label: 'proof:lemma', content: 'Lemma body: $x^2+y^2$.' }
    });
    expect(lemma.ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill('\\[a \\tooltip{\\le}{By [[proof:lemma]] and \\[\\frac{1}{2}\\].} b\\]');
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const target = page.locator('.cm-math-block .cm-math-explanation-trigger').first();
    await expect(target).toBeVisible();
    await target.click();
    const card = page.locator('.math-explanation-popover');
    await expect(card).toContainText('Cauchy lemma');
    await card.getByText('Cauchy lemma').click();
    await expect(card).toContainText('Lemma body');
    await expect(card.locator('.katex').first()).toBeVisible();
    await expect(card.locator('.embedded-editor-live .cm-content').first()).toHaveAttribute('contenteditable', 'false');
    await card.getByText('Cauchy lemma').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByRole('tab', { name: /Cauchy lemma/ })).toBeVisible();
    await expect(card).toHaveCount(0);
});

test('keeps a short explanation compact and outside the symbol', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`$a \tooltip{=}{CS} b$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const target = page.locator('.cm-math-explanation-trigger').first();
    await target.click();
    const card = page.locator('.math-explanation-popover');
    const [targetRect, cardRect] = await Promise.all([target.boundingBox(), card.boundingBox()]);
    expect(cardRect).not.toBeNull();
    expect(targetRect).not.toBeNull();
    expect(cardRect!.width).toBeLessThan(320);
    expect(cardRect!.y).toBeGreaterThanOrEqual(targetRect!.y + targetRect!.height);
});

test('draws relation outlines on the glyph rather than KaTeX trailing spacing', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`$a \tooltip{\le}{First.} b \tooltip{=}{Second.} c$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const targets = page.locator('.cm-math-explanation-trigger');
    await expect(targets).toHaveCount(2);
    for (const target of await targets.all()) {
        const indicator = target.locator(':scope > .cm-math-explanation-indicator');
        await expect(indicator).toHaveCount(1);
        await expect(indicator).toHaveClass(/mrel/);
        const [targetRect, indicatorRect] = await Promise.all([target.boundingBox(), indicator.boundingBox()]);
        expect(indicatorRect!.x + indicatorRect!.width).toBeLessThan(targetRect!.x + targetRect!.width);
        await target.click();
        await expect(page.locator('.math-explanation-popover')).toBeVisible();
        await page.keyboard.press('Escape');
    }
});

test('keeps a display explanation below the equation as an embedded block expands', async ({ page, request }) => {
    expect((await request.post('/api/blocks', {
        data: { title: 'Long lemma', label: 'example:long-lemma', content: 'A long proof.\n\n'.repeat(30) }
    })).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`\[a \tooltip{\le}{See [[example:long-lemma]].} b\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const equation = page.locator('.cm-math-block').first();
    await equation.locator('.cm-math-explanation-trigger').click();
    const card = page.locator('.math-explanation-popover');
    await card.getByText('Long lemma').click();
    await expect(card).toContainText('A long proof');
    const [equationRect, cardRect] = await Promise.all([equation.boundingBox(), card.boundingBox()]);
    expect(cardRect!.y).toBeGreaterThanOrEqual(equationRect!.y + equationRect!.height);
});

test('scrolls a low equation into view to leave room for its explanation below', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 500 });
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(`${'Some preceding text.\n\n'.repeat(20)}\\[a \\tooltip{\\le}{A short reason.} b\\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const equation = page.locator('.cm-math-block').first();
    await equation.locator('.cm-math-explanation-trigger').click();
    await expect.poll(async () => {
        const [equationRect, cardRect] = await Promise.all([
            equation.boundingBox(), page.locator('.math-explanation-popover').boundingBox()
        ]);
        return Boolean(equationRect && cardRect &&
            cardRect.y >= equationRect.y + equationRect.height && cardRect.y + cardRect.height <= 500);
    }).toBe(true);
});

test('opens a tooltip on a display sum at the visible operator', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`\[\tooltip{\sum_{i=1}^{n}}{Summing all terms.} a_i = b\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const target = page.locator('.cm-math-block .cm-math-explanation-trigger').first();
    const operator = target.locator('.mop').first();
    await expect(operator).toBeVisible();
    await operator.click();
    await expect(page.locator('.math-explanation-popover')).toContainText('Summing all terms.');
});

test('opens a tooltip on the lower limit beneath a display sum', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`\[\sum_{\tooltip{i=1}{The lower limit.}}^{n} a_i = b\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const target = page.locator('.cm-math-block .cm-math-explanation-trigger').first();
    await expect(target).toBeVisible();
    const rect = await target.boundingBox();
    expect(rect).not.toBeNull();
    await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    await expect(page.locator('.math-explanation-popover')).toContainText('The lower limit.');
});

test('keeps nested explanation cards usable inside an expanded lemma', async ({ page, request }) => {
    expect((await request.post('/api/blocks', {
        data: { title: 'Proof step', label: 'example:proof-step', content: 'Proof step body: $x^2$.' }
    })).ok()).toBeTruthy();
    expect((await request.post('/api/blocks', {
        data: { title: 'Inner lemma', label: 'example:inner-lemma',
            content: String.raw`$a \tooltip{\le}{Inner detail: [[example:proof-step]].} b$` }
    })).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`$u \tooltip{\le}{See [[example:inner-lemma∨]].} v$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    await page.locator('.cm-math-explanation-trigger').first().click();
    const cards = page.locator('.math-explanation-popover');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Inner lemma');
    await cards.first().locator('.cm-math-explanation-trigger').click();
    await expect(cards).toHaveCount(2);
    await cards.last().getByText('Proof step').click();
    await expect(cards).toHaveCount(2);
    await expect(cards.last()).toContainText('Proof step body');
    await page.keyboard.press('Escape');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Inner lemma');
});

test('shows one circular-reference marker in an explanation', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`$x \tooltip{=}{See [[showcase:main∨]].} x$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    await page.locator('.cm-math-explanation-trigger').first().click();
    await expect(page.locator('.math-explanation-popover [title="Circular embedding detected"]')).toHaveCount(1);
});
