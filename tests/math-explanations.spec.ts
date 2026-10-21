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

test('keeps embedded references literal while editing tooltip math', async ({ page, request }) => {
    expect((await request.post('/api/blocks', {
        data: { title: 'Literal-source lemma', label: 'proof:literal-source', content: 'Lemma body.' }
    })).ok()).toBeTruthy();
    await page.goto('/');
    const activePanel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const editor = activePanel.locator('.cm-content').first();
    const source = String.raw`\[a \tooltip{\le}{By [[proof:literal-source]] and \[q\].} b\]`;
    const clickBeforeText = async (needle: string) => {
        const line = activePanel.locator('.cm-line').filter({ hasText: needle }).first();
        const point = await line.evaluate((element, target) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            while ((text = walker.nextNode())) {
                const offset = text.textContent?.indexOf(target) ?? -1;
                if (offset < 0) continue;
                const range = document.createRange();
                range.setStart(text, offset);
                range.setEnd(text, offset + 1);
                const glyph = range.getBoundingClientRect();
                const row = element.getBoundingClientRect();
                return {
                    x: glyph.left - row.left + glyph.width / 4,
                    y: (glyph.top + glyph.bottom) / 2 - row.top
                };
            }
            throw new Error(`Could not find ${target} in raw math source`);
        }, needle);
        await line.click({ position: point });
    };
    await editor.fill(source);

    await expect(editor).toContainText('[[proof:literal-source]]');
    await expect(activePanel.locator('.cm-embedded-block-wrapper')).toHaveCount(0);
    await clickBeforeText('literal-source');
    await page.keyboard.insertText('X');
    await expect(editor).toContainText('[[proof:Xliteral-source]]');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await expect(editor).not.toContainText('∨');

    await editor.fill(String.raw`Inline $a \tooltip{\le}{By [[proof:literal-source]].} b$ source.`);
    await activePanel.locator('.cm-math-inline').first().click({ position: { x: 2, y: 2 } });
    await expect(activePanel.locator('.cm-math-editing')).toBeVisible();
    await expect(editor).toContainText('[[proof:literal-source]]');
    await expect(activePanel.locator('.cm-embedded-block-wrapper')).toHaveCount(0);
    await clickBeforeText('literal-source');
    await page.keyboard.insertText('Y');
    await expect(editor).toContainText('[[proof:Yliteral-source]]');
    await page.keyboard.press('Backspace');

    await editor.fill(source);

    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    await activePanel.locator('.cm-math-block .cm-math-explanation-trigger').first().click();
    const card = page.locator('.math-explanation-popover');
    await expect(card).toContainText('Literal-source lemma');
    await card.getByText('Literal-source lemma').click();
    await expect(card).toContainText('Lemma body.');
});

test('uses the explanation surface behind open embeds without changing note embed backgrounds', async ({ page, request }) => {
    const label = `proof:tooltip-surface-${Date.now()}`;
    expect((await request.post('/api/blocks', {
        data: { title: 'Tooltip surface lemma', label, content: 'Embedded proof body.' }
    })).ok()).toBeTruthy();

    await page.goto('/');
    const activePanel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const editor = activePanel.locator('.cm-content').first();
    await editor.fill(`[[${label}∨]]\n$x \\tooltip{=}{By [[${label}∨]].} y$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');

    const noteBody = activePanel.locator('[data-embed-nav-body="true"]').first();
    await expect(noteBody).toContainText('Embedded proof body.');
    expect(await noteBody.evaluate(element => getComputedStyle(element).backgroundColor))
        .not.toBe('rgba(0, 0, 0, 0)');

    await activePanel.locator('.cm-math-explanation-trigger').first().click();
    const popoverBody = page.locator('.math-explanation-popover [data-embed-nav-body="true"]').first();
    await expect(popoverBody).toContainText('Embedded proof body.');
    expect(await popoverBody.evaluate(element => getComputedStyle(element).backgroundColor))
        .toBe('rgba(0, 0, 0, 0)');
    await expect(popoverBody).toHaveCSS('border-left-width', '2px');
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

test('gives display math more room while keeping very long equations scrollable', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(`$a \\tooltip{=}{A longer equation: \\[${'a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t+u+v+w+x+y+z+'.repeat(3)}0\\]} b$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    await page.locator('.cm-math-explanation-trigger').first().click();
    const card = page.locator('.math-explanation-popover');
    await expect(card.locator('.cm-math-block')).toBeVisible();
    const dimensions = await card.evaluate(element => ({
        width: element.getBoundingClientRect().width,
        equationScrollWidth: element.querySelector('.cm-math-block')?.scrollWidth ?? 0,
        equationClientWidth: element.querySelector('.cm-math-block')?.clientWidth ?? 0
    }));
    expect(dimensions.width).toBeGreaterThan(440);
    expect(dimensions.width).toBeLessThanOrEqual(900);
    expect(dimensions.equationScrollWidth).toBeGreaterThan(dimensions.equationClientWidth);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect.poll(() => card.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(366);
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

test('anchors a display explanation below its symbol as an embedded block expands', async ({ page, request }) => {
    expect((await request.post('/api/blocks', {
        data: { title: 'Long lemma', label: 'example:long-lemma', content: 'A long proof.\n\n'.repeat(30) }
    })).ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`\[\begin{aligned}a &\tooltip{\le}{See [[example:long-lemma]].} b \\ c &= d \\ e &= f\end{aligned}\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const equation = page.locator('.cm-math-block').first();
    const target = equation.locator('.cm-math-explanation-trigger');
    await target.click();
    const card = page.locator('.math-explanation-popover');
    await card.getByText('Long lemma').click();
    await expect(card).toContainText('A long proof');
    const [equationRect, targetRect, cardRect] = await Promise.all([
        equation.boundingBox(), target.boundingBox(), card.boundingBox()
    ]);
    expect(Math.abs(cardRect!.y - (targetRect!.y + targetRect!.height + 8))).toBeLessThan(3);
    expect(cardRect!.y).toBeLessThan(equationRect!.y + equationRect!.height);
});

test('scrolls a low symbol into view to leave room for its explanation below', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 500 });
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(`${'Some preceding text.\n\n'.repeat(20)}\\[a \\tooltip{\\le}{A short reason.} b\\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    const equation = page.locator('.cm-math-block').first();
    const target = equation.locator('.cm-math-explanation-trigger');
    await target.click();
    await expect.poll(async () => {
        const [targetRect, cardRect] = await Promise.all([
            target.boundingBox(), page.locator('.math-explanation-popover').boundingBox()
        ]);
        return Boolean(targetRect && cardRect &&
            cardRect.y >= targetRect.y + targetRect.height && cardRect.y + cardRect.height <= 500);
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

test('hovers and toggles a lower explanation through an overlapping KaTeX vlist', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`\[\begin{aligned}
        a &\tooltip{\le}{Upper reason.} b \\
          &\tooltip{\le}{Lower reason.} c
    \end{aligned}\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');

    const targets = page.locator('.cm-math-block .cm-math-explanation-trigger');
    await expect(targets).toHaveCount(2);
    const lower = targets.nth(1);
    const rect = await lower.boundingBox();
    expect(rect).not.toBeNull();
    const point = { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 };

    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('vlist'), point)).toBe(true);
    await page.mouse.move(point.x, point.y);
    await expect(lower).toHaveClass(/cm-math-explanation-logical-hover/);

    await page.mouse.click(point.x, point.y);
    const card = page.locator('.math-explanation-popover');
    await expect(card).toContainText('Lower reason.');
    await page.mouse.click(point.x, point.y);
    await expect(card).toHaveCount(0);
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
