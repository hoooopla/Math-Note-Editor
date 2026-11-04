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

test('folding a heading hides its section without removing later headings', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('# First\nfirst body\n## Child\nchild body\n# Second\nsecond body');
    const fold = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-heading-fold-toggle:visible').first();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-heading-fold-toggle:visible')).toHaveCount(3);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-gutters')).toHaveCount(0);
    const headingFont = await editor.locator('.cm-heading-line').first().evaluate(element => getComputedStyle(element).fontSize);
    const arrowFont = await fold.evaluate(element => getComputedStyle(element).fontSize);
    expect(arrowFont).toBe(headingFont);
    const arrowBox = (await fold.boundingBox())!;
    const headingBox = (await editor.locator('.cm-heading-line').first().boundingBox())!;
    expect(arrowBox.x + arrowBox.width).toBeLessThanOrEqual(headingBox.x);
    expect(headingBox.x - arrowBox.x).toBeLessThan(20);
    await page.mouse.move(0, 0);
    await expect(fold).toHaveCSS('opacity', '0');
    await editor.locator('.cm-heading-line').first().hover();
    await expect(fold).toHaveCSS('opacity', '1');
    const openIcon = fold.locator('svg');
    const iconPath = await openIcon.locator('path').getAttribute('d');
    const openIconBox = (await openIcon.boundingBox())!;
    await expect(openIcon).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
    await fold.click();
    await expect(editor.locator('.cm-heading-fold-placeholder')).toBeVisible();
    await expect(editor.locator('.cm-heading-fold-placeholder')).toHaveText('...');
    const foldedHeading = editor.locator('.cm-heading-folded-line').first();
    await expect(foldedHeading).toBeVisible();
    await page.mouse.move(0, 0);
    const foldedToggle = foldedHeading.locator('.cm-heading-fold-toggle');
    await expect(foldedToggle).toHaveCSS('opacity', '1');
    const closedIcon = foldedToggle.locator('svg');
    await expect(closedIcon.locator('path')).toHaveAttribute('d', iconPath!);
    await expect(closedIcon).toHaveCSS('transform', 'none');
    const closedIconBox = (await closedIcon.boundingBox())!;
    expect(closedIconBox.width).toBe(openIconBox.width);
    expect(closedIconBox.height).toBe(openIconBox.height);
    expect(Number.parseFloat(await foldedHeading.evaluate(element => getComputedStyle(element).paddingLeft))).toBeGreaterThan(0);
    await expect(editor).not.toContainText('child body');
    await expect(editor).toContainText('Second');
    const firstLine = editor.locator('.cm-heading-line').filter({ hasText: 'First' }).first();
    const secondLine = editor.locator('.cm-heading-line').filter({ hasText: 'Second' }).first();
    expect((await secondLine.boundingBox())!.y).toBeGreaterThan((await firstLine.boundingBox())!.y);
    await editor.locator('.cm-heading-fold-placeholder').click();
    await expect(editor).toContainText('child body');
});

test('outline navigation reveals a heading inside a folded section', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('# First\nfirst body\n## Child\nchild body\n# Second\nsecond body');
    await editor.evaluate((element: HTMLElement) => element.blur());
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-heading-fold-toggle:visible').first().click();
    await expect(editor).not.toContainText('Child');
    await page.getByRole('button', { name: 'Open content outline' }).click();
    await page.getByRole('button', { name: 'Child', exact: true }).click();
    await expect(editor).toContainText('Child');
});

test('nested folds preserve math and list content when reopened', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('# Parent\n- first item\n$$x^2+y^2$$\n## Child\nchild detail\n# Peer\npeer detail');
    await editor.locator('.cm-heading-line').filter({ hasText: 'Child' }).locator('.cm-heading-fold-toggle').click();
    await expect(editor).not.toContainText('child detail');
    await editor.locator('.cm-heading-line').filter({ hasText: 'Parent' }).locator('.cm-heading-fold-toggle').click();
    await expect(editor).not.toContainText('first item');
    await expect(editor).toContainText('Peer');
    await editor.locator('.cm-heading-line').filter({ hasText: 'Parent' }).locator('.cm-heading-fold-toggle').click();
    await expect(editor).toContainText('first item');
    await expect(editor).toContainText('$$x^2+y^2$$');
    await expect(editor).not.toContainText('child detail');
    await editor.locator('.cm-heading-line').filter({ hasText: 'Child' }).locator('.cm-heading-fold-toggle').click();
    await expect(editor).toContainText('child detail');
});

test('outline navigation reaches a heading inside an embedded block hidden by a fold', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:fold-child-${suffix}`;
    const rootLabel = `test:fold-root-${suffix}`;
    await page.request.post('/api/blocks', { data: {
        title: 'Fold child', label: childLabel, content: '# Inner heading\ninside detail'
    } });
    await page.request.post('/api/blocks', { data: {
        title: 'Fold root', label: rootLabel, content: `# Outer heading\n[[${childLabel}∨]]\n# Peer heading\npeer detail`
    } });
    await page.goto('/');
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    await panel.locator('.cm-heading-line').filter({ hasText: 'Outer heading' }).locator('.cm-heading-fold-toggle').click();
    await expect(panel).not.toContainText('Inner heading');
    await page.getByRole('button', { name: 'Open content outline' }).click();
    await page.getByRole('button', { name: 'Inner heading', exact: true }).click();
    await expect(panel).toContainText('Inner heading');
    await expect(panel.locator('.cm-heading-line').filter({ hasText: 'Outer heading' })).not.toHaveClass(/cm-heading-folded-line/);
    await panel.locator('.cm-heading-line').filter({ hasText: 'Inner heading' }).locator('.cm-heading-fold-toggle').click();
    const outline = page.getByRole('tree', { name: 'Sections in reading order' });
    await expect(outline.getByLabel('Folded in note')).toHaveCount(0);
});

test('Match note follows the editor fold state without changing the note', async ({ page }) => {
    await page.goto('/');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const editor = panel.locator('.cm-content').first();
    await editor.fill('# Parent\n## Child\nchild detail\n# Peer\npeer detail');
    await page.getByRole('button', { name: 'Open content outline' }).click();
    const outline = page.getByRole('tree', { name: 'Sections in reading order' });
    const parent = outline.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Parent', exact: true }) }).first();
    await editor.locator('.cm-heading-line').filter({ hasText: 'Parent' }).locator('.cm-heading-fold-toggle').click();
    await expect(parent.getByLabel('Folded in note')).toHaveCount(0);
    await page.getByRole('button', { name: 'Match note' }).click();
    await expect(parent).toHaveAttribute('aria-expanded', 'false');
    await parent.getByRole('button', { name: 'Expand Parent' }).click();
    await expect(parent).toHaveAttribute('aria-expanded', 'true');
    await expect(editor.locator('.cm-heading-folded-line')).toHaveCount(1);
    await editor.locator('.cm-heading-line').filter({ hasText: 'Parent' }).locator('.cm-heading-fold-toggle').click();
    await page.getByRole('button', { name: 'Match note' }).click();
    await expect(parent).toHaveAttribute('aria-expanded', 'true');
});
