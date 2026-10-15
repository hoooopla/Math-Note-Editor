import { expect, test } from 'playwright/test';
import { findTextMatches, matchExcerpt } from '../src/lib/content-find';

test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBeTruthy();
});

test('literal matches keep source offsets after Unicode case folding and excerpt the correct occurrence', () => {
    expect(findTextMatches('İ x needle', 'needle')).toEqual([{ from: 4, to: 10 }]);
    expect(findTextMatches('a [x] b', '[x]')).toEqual([{ from: 2, to: 5 }]);
    const source = 'word then word then word';
    const matches = findTextMatches(source, 'word');
    expect(matches).toHaveLength(3);
    expect(matchExcerpt(source, matches[1])).toEqual({ before: 'word then ', matched: 'word', after: ' then word' });
});

test('a quick Enter searches all notes and opens a match after its body loads', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Quick find note', label: 'find:quick-note', content: 'A singular bluedragon appears here.'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Search scope').selectOption('all');
    const input = find.getByLabel('Find in content');
    await input.fill('bluedragon');
    await input.press('Enter');
    await expect(find).toContainText('1/1');
    await expect(page.getByRole('tab', { name: /Quick find note/ })).toHaveAttribute('aria-selected', 'true');
    await expect(input).toBeFocused();
});

test('a long result list renders nearby rows and keeps the last keyboard match visible', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(Array.from({ length: 40 }, (_, index) => `line ${index} violetneedle`).join('\n'));
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    const input = find.getByLabel('Find in content');
    await input.fill('violetneedle');
    await expect(find).toContainText('0/40');
    const options = find.getByRole('listbox').getByRole('option');
    expect(await options.count()).toBeLessThan(40);
    await input.press('Shift+Enter');
    await expect(find).toContainText('40/40');
    await expect(options.filter({ hasText: 'line 39 violetneedle' })).toHaveAttribute('aria-selected', 'true');
    await expect(input).toBeFocused();
});

test('open tabs discovers matches in an expanded child after a background root loads', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Lazy child', label: 'find:lazy-child', content: 'A marmaladechild theorem.'
    } })).ok()).toBeTruthy();
    const parent = await (await request.post('/api/blocks', { data: {
        title: 'Lazy parent', label: 'find:lazy-parent', content: '[[find:lazy-child∨]]'
    } })).json();
    await page.route(`**/api/blocks/${parent.id}`, async route => {
        await new Promise(resolve => setTimeout(resolve, 400));
        await route.continue();
    });
    await page.goto('/');
    const original = page.getByRole('tab', { name: /Welcome to Math Note/ });
    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill('Lazy parent');
    await search.press('Enter');
    await original.click();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Search scope').selectOption('tabs');
    await find.getByLabel('Find in content').fill('marmaladechild');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await expect(find.getByRole('listbox').getByRole('option')).toContainText('Lazy child');
});

test('Cmd/Ctrl+F finds visible source, changes scope, and leaves block search separate', async ({ page, request }) => {
    const distant = await request.post('/api/blocks', { data: { title: 'Far lemma', label: 'proof:far', content: 'A distant zebra lemma with $x^2$.' } });
    expect(distant.ok()).toBeTruthy();
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toBeVisible();
    await editor.fill('Visible zebra and $zebra^2$.');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await expect(find).toBeVisible();
    await expect(find.getByLabel('Search scope')).toHaveValue('visible');
    await expect(find).toContainText('Displayed text and titles in this tab');
    await find.getByLabel('Find in content').fill('zebra');
    await expect(find).toContainText('0/2');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(2);
    await find.getByLabel('Find in content').press('Enter');
    await expect(find).toContainText('1/2');
    await find.getByLabel('Find in content').press('Enter');
    await expect(find).toContainText('2/2');
    await find.getByLabel('Find in content').press('Shift+Enter');
    await expect(find).toContainText('1/2');
    await find.getByLabel('Search scope').selectOption('all');
    await expect(find.getByRole('listbox').getByRole('option').filter({ hasText: 'Far lemma' })).toBeVisible();
    await find.getByRole('listbox').getByRole('option').filter({ hasText: 'Far lemma' }).click();
    await expect(page.getByRole('tab', { name: /Far lemma/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(find).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByPlaceholder('Search blocks or create new...')).toBeVisible();
});

test('visible scope includes an open explanation', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`$a \tooltip{=}{rarelemma explanation} b$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('rarelemma');
    await expect(find).toContainText('0/0');
    await page.locator('.cm-math-explanation-trigger').first().click();
    await expect(find).toContainText('0/1');
});

test('visible scope finds a rendered math symbol', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(String.raw`$a \le b$`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cm-math-inline .katex-html')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('≤');
    await expect(find).toContainText('0/1');
    await expect(find.getByRole('listbox').getByRole('option').locator('mark')).toHaveText('≤');
    await find.getByLabel('Find in content').press('Enter');
    await expect(page.locator('.cm-find-current-math')).toBeVisible();
});

test('visible scope includes an expanded embedded note', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-content').first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('Click here and type something');
    await expect(find).toContainText('0/1');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await expect(find.getByRole('listbox').getByRole('option')).toContainText('An embedded note you can edit');
});

test('open tabs searches displayed titles while all notes also searches labels', async ({ page, request }) => {
    const created = await request.post('/api/blocks', { data: { title: 'Quokka theorem', label: 'proof:quokka', content: '' } });
    expect(created.ok()).toBeTruthy();
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('quokka');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Search scope').selectOption('all');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(2);
    await expect(find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' })).toBeVisible();
    await expect(find.getByRole('listbox').getByRole('option').filter({ hasText: 'Label:' })).toBeVisible();
    await find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' }).click();
    await expect(page.getByRole('tab', { name: /Quokka theorem/ })).toBeVisible();
    await find.getByLabel('Search scope').selectOption('tabs');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await find.getByLabel('Search scope').selectOption('visible');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await find.getByLabel('Find in content').fill('proof:quokka');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Search scope').selectOption('tabs');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Search scope').selectOption('all');
    await expect(find.getByRole('listbox').getByRole('option').filter({ hasText: 'Label:' })).toBeVisible();
});

test('all notes keeps title, label, and source matches in note order without moving the editor cursor', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Quokkafind theorem', label: 'proof:quokkafind', content: 'first quokkafind\nsecond quokkafind'
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/blocks', { data: {
        title: 'Following theorem', label: 'proof:following', content: 'third quokkafind'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    const input = find.getByLabel('Find in content');
    await find.getByLabel('Search scope').selectOption('all');
    await input.fill('quokkafind');
    const results = find.getByRole('listbox').getByRole('option');
    await expect(results).toHaveCount(5);
    const lines = await results.allTextContents();
    const quokkaStart = lines.findIndex(line => line.includes('Title:'));
    expect(quokkaStart === 0 || quokkaStart === 1).toBeTruthy();
    expect(lines[quokkaStart + 1]).toContain('Label:');
    expect(lines[quokkaStart + 2]).toContain('first quokkafind');
    expect(lines[quokkaStart + 3]).toContain('second quokkafind');
    expect(lines[quokkaStart === 0 ? 4 : 0]).toContain('third quokkafind');
    for (let index = 0; index < 5; index++) {
        await input.press('Enter');
        await expect(results.nth(index)).toHaveAttribute('aria-selected', 'true');
        await expect(input).toBeFocused();
        const quokkaResult = index >= quokkaStart && index < quokkaStart + 4;
        await expect(page.getByRole('tab', { name: quokkaResult ? /Quokkafind theorem/ : /Following theorem/ })).toHaveAttribute('aria-selected', 'true');
        if (index === quokkaStart || index === quokkaStart + 1) {
            await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-find-current-metadata')).toBeVisible();
            await expect.poll(() => page.evaluate(() => CSS.highlights?.get('content-find-target')?.size || 0)).toBe(1);
        } else {
            await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-find-exact-match')).toBeVisible();
            await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-find-exact-match')).toHaveText('quokkafind');
        }
    }
    await input.press('Shift+Enter');
    await expect(results.nth(3)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toBeFocused();
});

test('all notes reveals matches inside rendered math and an embedded link as source', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Target note', label: 'find:quokkafind-target', content: 'An embedded note.'
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/blocks', { data: {
        title: 'Source note', label: 'find:quokkafind-source',
        content: String.raw`Before $a \le b$ and [[find:quokkafind-target||Target title]].`
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    const input = find.getByLabel('Find in content');
    await find.getByLabel('Search scope').selectOption('all');
    await input.fill(String.raw`\le`);
    const results = find.getByRole('listbox').getByRole('option');
    await expect(results).toHaveCount(1);
    await input.press('Enter');
    await expect(input).toBeFocused();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-find-exact-match')).toHaveText(String.raw`\le`);
    await input.fill('quokkafind-target');
    await expect(results).toHaveCount(2);
    await results.filter({ hasText: 'Before' }).click();
    await expect(input).toBeFocused();
    await expect(page.getByRole('tab', { name: /Source note/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-find-exact-match')).toHaveText('quokkafind-target');
});

test('open tabs follows current-view rules and reveals a closed title in another tab', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Hidden source title', label: 'find:other-tab-target', content: 'A proof.'
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/blocks', { data: {
        title: 'Second tab', label: 'find:second-tab', content: 'before needle\n[[find:other-tab-target||Visible needle title]]\nafter needle'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const originalTab = page.getByRole('tab', { name: /Welcome to Math Note Editor/ });
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Search scope').selectOption('all');
    await find.getByLabel('Find in content').fill('Second tab');
    await find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' }).click();
    await expect(page.getByRole('tab', { name: /Second tab/ })).toBeVisible();
    await originalTab.click();
    await find.getByLabel('Search scope').selectOption('tabs');
    await find.getByLabel('Find in content').fill('find:other-tab-target');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Find in content').fill('needle');
    const results = find.getByRole('listbox').getByRole('option');
    await expect(results).toHaveCount(3);
    await expect(results.nth(0)).toContainText('before needle');
    await expect(results.nth(1)).toContainText('Visible needle title');
    await expect(results.nth(2)).toContainText('after needle');
    await results.nth(1).click();
    await expect(page.getByRole('tab', { name: /Second tab/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Visible needle title' })).toHaveClass(/cm-find-current-metadata/);
    await originalTab.click();
    await find.getByLabel('Find in content').press('Enter');
    await expect(page.getByRole('tab', { name: /Second tab/ })).toHaveAttribute('aria-selected', 'true');
    await expect(find.getByRole('listbox').getByRole('option').nth(2)).toHaveAttribute('aria-selected', 'true');
});

test('open tabs includes an expanded note in a background tab', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Inner proof', label: 'find:tabs-inner', content: 'velvet axiom'
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/blocks', { data: {
        title: 'Second tab', label: 'find:tabs-parent', content: '[[find:tabs-inner]]'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const originalTab = page.getByRole('tab', { name: /Welcome to Math Note Editor/ });
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Search scope').selectOption('all');
    await find.getByLabel('Find in content').fill('Second tab');
    await find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' }).click();
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Inner proof' }).click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-content')).toBeVisible();
    await originalTab.click();
    await find.getByLabel('Search scope').selectOption('tabs');
    await find.getByLabel('Find in content').fill('velvet axiom');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await find.getByLabel('Find in content').press('Enter');
    await expect(page.getByRole('tab', { name: /Second tab/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-find-target .cm-selectionBackground').last()).toBeVisible();
});

test('open tabs finds rendered math in a background tab', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Inequality note', label: 'find:math-tab', content: String.raw`$a \le b$`
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const originalTab = page.getByRole('tab', { name: /Welcome to Math Note Editor/ });
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Search scope').selectOption('all');
    await find.getByLabel('Find in content').fill('Inequality note');
    await find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' }).click();
    await page.getByRole('heading', { name: /Math Note Editor/ }).click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-math-inline .katex-html, [role="tabpanel"][aria-hidden="false"] .cm-math-block .katex-html')).toBeVisible();
    await originalTab.click();
    await find.getByLabel('Search scope').selectOption('tabs');
    await find.getByLabel('Find in content').fill('≤');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await find.getByLabel('Find in content').press('Enter');
    await expect(page.getByRole('tab', { name: /Inequality note/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-find-current-math')).toBeVisible();
});

test('open tabs keeps nested results stable as the active tab changes', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Inner proof', label: 'find:stable-inner', content: 'inside marmalade'
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/blocks', { data: {
        title: 'Second tab', label: 'find:stable-parent', content: 'before marmalade\n[[find:stable-inner∨]]\nafter marmalade'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const originalTab = page.getByRole('tab', { name: /Welcome to Math Note Editor/ });
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Search scope').selectOption('all');
    await find.getByLabel('Find in content').fill('Second tab');
    await find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' }).click();
    await originalTab.click();
    await find.getByLabel('Search scope').selectOption('tabs');
    await find.getByLabel('Find in content').fill('marmalade');
    const results = find.getByRole('listbox').getByRole('option');
    await expect(results).toHaveCount(3);
    await expect(results.nth(1)).toContainText('inside marmalade');
    await results.nth(1).click();
    await expect(page.getByRole('tab', { name: /Second tab/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-find-target .cm-selectionBackground').last()).toBeVisible();
    await expect(results).toHaveCount(3);
    await originalTab.click();
    await expect(results).toHaveCount(3);
});

test('moving to another editor clears the previous selected match', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Inner note', label: 'find:selection-inner', content: 'inside needle'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first().fill('before needle\n[[find:selection-inner∨]]');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-content')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('needle');
    const results = find.getByRole('listbox').getByRole('option');
    await expect(results).toHaveCount(2);
    await results.first().click();
    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] [data-find-root="true"] .cm-editor').first();
    const rootSelectionCount = () => rootEditor.evaluate(editor => [...editor.querySelectorAll('.cm-selectionBackground')].filter(element => element.closest('.cm-editor') === editor).length);
    await expect.poll(rootSelectionCount).toBe(1);
    await results.last().click();
    await expect.poll(rootSelectionCount).toBe(0);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-find-target .cm-selectionBackground').last()).toBeVisible();
});

test('Enter reveals the selected occurrence in a long note', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill(`needle first\n${'ordinary line\n'.repeat(100)}needle second`);
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    const input = find.getByLabel('Find in content');
    await input.fill('needle');
    await expect(find).toContainText('0/2');
    await input.press('Enter');
    await expect(find).toContainText('1/2');
    await input.press('Enter');
    await expect(find).toContainText('2/2');
    const selected = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-selectionBackground').last();
    await expect(selected).toBeVisible();
    const box = await selected.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.y).toBeLessThan(viewport!.height);
});

test('repeated words on one line highlight and select their own occurrence', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.fill('first needle then second needle');
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    const input = find.getByLabel('Find in content');
    await input.fill('needle');
    const rows = find.getByRole('listbox').getByRole('option');
    await expect(rows).toHaveCount(2);
    const beforeFirst = await rows.nth(0).locator('mark').evaluate(mark => mark.previousSibling?.textContent || '');
    const beforeSecond = await rows.nth(1).locator('mark').evaluate(mark => mark.previousSibling?.textContent || '');
    expect(beforeSecond.length).toBeGreaterThan(beforeFirst.length);
    await input.press('Enter');
    const selection = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-selectionBackground').last();
    await expect(selection).toBeVisible();
    const firstBox = await selection.boundingBox();
    await input.press('Enter');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    const secondBox = await selection.boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(secondBox!.x).toBeGreaterThan(firstBox!.x);
});

test('current view results stay in the tab for an expanded embedded note', async ({ page, request }) => {
    const child = await request.post('/api/blocks', { data: {
        title: 'Unique embedded theorem', label: 'find:embedded-theorem', content: 'Inside this note is a velvet axiom.'
    } });
    expect(child.ok()).toBeTruthy();
    await page.goto('/');
    const root = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await root.fill('[[find:embedded-theorem]]');
    const title = page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Unique embedded theorem' }).first();
    await expect(title).toBeVisible();
    await title.click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-content').first()).toBeVisible();
    const originalTab = await page.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
    const originalTabCount = await page.getByRole('tab').count();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('Unique embedded theorem');
    await find.getByLabel('Find in content').press('Enter');
    await expect(title).toHaveClass(/cm-find-current-metadata/);
    expect(await page.getByRole('tab').count()).toBe(originalTabCount);
    await find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' }).click();
    await expect(title).toHaveClass(/cm-find-current-metadata/);
    expect(await page.getByRole('tab').count()).toBe(originalTabCount);
    expect(await page.locator('[role="tab"][aria-selected="true"]').getAttribute('id')).toBe(originalTab);
    await find.getByLabel('Find in content').fill('find:embedded-theorem');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Find in content').fill('embedded-theorem');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Find in content').fill('velvet axiom');
    await find.getByRole('listbox').getByRole('option').first().click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-find-target .cm-selectionBackground').last()).toBeVisible();
    expect(await page.getByRole('tab').count()).toBe(originalTabCount);
    expect(await page.locator('[role="tab"][aria-selected="true"]').getAttribute('id')).toBe(originalTab);
});

test('current view distinguishes repeated embedded occurrences', async ({ page, request }) => {
    const child = await request.post('/api/blocks', { data: {
        title: 'Repeated local theorem', label: 'find:repeated-theorem', content: 'An embedded statement.'
    } });
    expect(child.ok()).toBeTruthy();
    await page.goto('/');
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first().fill('[[find:repeated-theorem]] and [[find:repeated-theorem]]');
    const titles = page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Repeated local theorem' });
    await expect(titles).toHaveCount(2);
    await titles.first().click();
    await titles.last().click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .embedded-editor-live .cm-content')).toHaveCount(2);
    const originalTabCount = await page.getByRole('tab').count();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('Repeated local theorem');
    const titleResults = find.getByRole('listbox').getByRole('option').filter({ hasText: 'Title:' });
    await expect(titleResults).toHaveCount(2);
    await titleResults.last().click();
    await expect(titles.last()).toHaveClass(/cm-find-current-metadata/);
    await expect(titles.first()).not.toHaveClass(/cm-find-current-metadata/);
    expect(await page.getByRole('tab').count()).toBe(originalTabCount);
});

test('closed embedded titles highlight in place, while hidden label paths do not match', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Poisson equation', label: 'notes/Laplace/poisson', content: 'A related equation.'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first().fill('[[notes/Laplace/poisson]]');
    const title = page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Poisson equation' });
    await expect(title).toBeVisible();
    const tabCount = await page.getByRole('tab').count();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('Laplace');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Find in content').fill('Poisson');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await find.getByLabel('Find in content').press('Enter');
    await expect(title).toHaveClass(/cm-find-current-metadata/);
    expect(await page.getByRole('tab').count()).toBe(tabCount);
});

test('current view searches the displayed alias instead of its underlying title', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Laplace equation', label: 'find:alias-target', content: 'A related equation.'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first().fill('[[find:alias-target||Heat equation]]');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Heat equation' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('Laplace');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await find.getByLabel('Find in content').fill('Heat');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await find.getByLabel('Find in content').press('Enter');
    await expect(page.locator('[data-embed-nav-title]').filter({ hasText: 'Heat equation' })).toHaveClass(/cm-find-current-metadata/);
});

test('current view orders root and expanded embedded matches by page position', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Inner note', label: 'find:visual-order', content: 'inside needle'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first().fill('before needle\n[[find:visual-order]]\nafter needle');
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Inner note' }).click();
    await expect(page.locator('.embedded-editor-live .cm-content')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('needle');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(3);
    const excerpts = await find.getByRole('listbox').getByRole('option').allTextContents();
    expect(excerpts[0]).toContain('before needle');
    expect(excerpts[1]).toContain('inside needle');
    expect(excerpts[2]).toContain('after needle');
});

test('current view includes a closed title beyond the mounted editor viewport', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Distant Laplace lemma', label: 'find:distant-laplace', content: 'A short proof.'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const root = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await root.fill(`first Laplace\n${'ordinary line\n'.repeat(180)}[[find:distant-laplace]]`);
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('Laplace');
    const results = find.getByRole('listbox').getByRole('option');
    await expect(results).toHaveCount(2);
    await expect(results.nth(0)).toContainText('first Laplace');
    await expect(results.nth(1)).toContainText('Distant Laplace lemma');
    await results.nth(1).click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Distant Laplace lemma' })).toHaveClass(/cm-find-current-metadata/);
});

test('current view includes a closed title inside an expanded embedded note', async ({ page, request }) => {
    expect((await request.post('/api/blocks', { data: {
        title: 'Nested Laplace lemma', label: 'find:nested-laplace', content: 'A short proof.'
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/blocks', { data: {
        title: 'Parent note', label: 'find:parent-note', content: 'Intro\n[[find:nested-laplace]]\nOutro'
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first().fill('[[find:parent-note]]');
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Parent note' }).click();
    const nestedTitle = page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]').filter({ hasText: 'Nested Laplace lemma' });
    await expect(nestedTitle).toBeVisible();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByTestId('content-find-panel');
    await find.getByLabel('Find in content').fill('Laplace');
    await expect(find.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await find.getByLabel('Find in content').press('Enter');
    await expect(nestedTitle).toHaveClass(/cm-find-current-metadata/);
});
