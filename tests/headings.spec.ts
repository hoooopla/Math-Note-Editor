import { expect, test } from 'playwright/test';

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

test('renders headings flush left in white, with editable full-size inline math', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('## Fourier $f_m(r)$\nOrdinary paragraph\n```md\n# Not a heading\n```');
    await editor.evaluate((element: HTMLElement) => element.blur());
    const heading = editor.locator('.cm-heading-level-2');
    await expect(heading).toHaveCount(1);
    await expect(heading.locator('.cm-math-inline')).toBeVisible();
    await expect(heading.locator('.cm-heading-marker')).toHaveCount(0);
    await expect(editor.locator('.cm-heading-line')).toHaveCount(1);
    const line = await heading.boundingBox();
    const title = heading.getByText('Fourier');
    const titleBox = await title.boundingBox();
    expect(Math.abs(titleBox!.x - line!.x)).toBeLessThan(2);
    await expect(title).toHaveCSS('color', 'rgb(255, 255, 255)');
    await title.click();
    await expect(heading.locator('.cm-heading-marker')).toContainText('##');
    await heading.locator('.cm-math-inline').click();
    const headingSize = await heading.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    const mathSize = await heading.locator('.cm-math-editing').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    expect(Math.abs(mathSize - headingSize)).toBeLessThan(1);
    const commandColors = await heading.locator('.cm-math-delimiter').first().evaluate(element => ({
        token: getComputedStyle(element).color,
        text: getComputedStyle(element.querySelector('span')!).color
    }));
    expect(commandColors.text).toBe(commandColors.token);
});

test('Enter leaves a heading and Backspace removes its complete marker', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('## Working title');
    await editor.locator('.cm-heading-line').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('Body text');
    await expect(editor.locator('.cm-heading-line')).toHaveCount(1);
    await expect(editor.locator('.cm-line').last()).toContainText('Body text');
    await editor.locator('.cm-heading-line').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await expect(editor.locator('.cm-heading-line')).toHaveCount(0);
    await expect(editor).toContainText('Working title');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('.cm-heading-line')).toHaveCount(1);
});

test('a heading inside a quote keeps the quote continuation on Enter', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('> ## Quoted heading');
    await expect(editor.locator('.cm-heading-level-2')).toHaveCount(1);
    await editor.locator('.cm-heading-line').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('body');
    await expect(editor.locator('.cm-heading-line')).toHaveCount(1);
    await expect(editor.locator('.cm-line').last().locator('.cm-quote-run')).toContainText('body');
});

test('editing or deleting an empty heading marker updates the rendered level', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('### ');
    await expect(editor.locator('.cm-heading-level-3')).toHaveCount(1);
    await page.keyboard.insertText('Draft');
    await expect(editor.locator('.cm-heading-level-3')).toContainText('Draft');
    for (let index = 0; index < 'Draft'.length; index++) await page.keyboard.press('Backspace');
    await expect(editor.locator('.cm-heading-level-3')).toHaveCount(1);
    await page.keyboard.press('Backspace');
    await expect(editor.locator('.cm-heading-line')).toHaveCount(0);
});
