import { expect, test, type Locator, type Page } from 'playwright/test';
import { openEditor, replaceEditorText } from './helpers/editor';
import { computeReferences, metadataText, parseFrontmatter, stringifyFrontmatter } from '../src/lib/block-metadata';
import { encodeEmbeddedLabel, findActiveEmbeddedTarget, parseEmbeddedLinks, resolveEmbeddedLabel } from '../src/lib/embedded-link-syntax';
import { makeBlockFilename, validateBlockLabel } from '../src/lib/label-policy';
import { applySafeRelabelPlan, buildSafeRelabelPlan, relabelPlanSignatureInput } from '../src/lib/safe-relabel';
import { findDuplicateLabelIssues } from '../src/lib/workspace-validation';
import { rankSearchResults } from '../src/lib/search-ranking';
import { buildBacklinkIndex, findBacklinkOccurrences } from '../src/lib/backlinks';
import { buildBlockMapModel } from '../src/lib/block-map';
import { isEmbeddedLayoutHydration } from '../src/lib/embedded-layout-compatibility';
import { decodedAssetPath, encodedAssetReference, imageReference, scanImageReferences, validateAssetPath } from '../src/lib/asset-reference';
import { imageSignatureMatches, imageUploadLimit, validateImageFilename, validateImageUpload } from '../src/lib/image-upload-policy';
import { buildAssetMovePlan, replaceAssetImageReferences } from '../src/lib/safe-asset-move';
import {
    getEmbeddedEditorLifecycleStateForTests,
    initialEmbeddedEditorPhase,
    resetEmbeddedEditorLifecycle
} from '../src/lib/embedded-editor-lifecycle';
import { standoutDisplayTitle } from '../src/lib/title-display';

test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset');
    expect(response.ok()).toBeTruthy();
});

test('capitalizes only a leading lowercase letter for standout presentation', () => {
    expect(standoutDisplayTitle('countable subadditivity')).toBe('Countable subadditivity');
    expect(standoutDisplayTitle('énergie estimate')).toBe('Énergie estimate');
    expect(standoutDisplayTitle('ODE estimate')).toBe('ODE estimate');
    expect(standoutDisplayTitle('$f$ is smooth')).toBe('$f$ is smooth');
    expect(standoutDisplayTitle('\\[f\\] is smooth')).toBe('\\[f\\] is smooth');
    expect(standoutDisplayTitle('(local) estimate')).toBe('(local) estimate');
    expect(standoutDisplayTitle('2-dimensional estimate')).toBe('2-dimensional estimate');
    expect(standoutDisplayTitle(' leading space')).toBe(' leading space');
});

test('standout label context menu copies the full label without toggling the embed', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    const suffix = Date.now();
    const label = `test:standout-long-prefix-${'shared-'.repeat(12)}target-${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: { title: 'Copyable target', label, content: 'Target body' }
    })).json() as { id: string };
    const sourceLabel = `test:standout-copy-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Copy source', label: sourceLabel, content: `[[@${label}]]` }
    });
    await openEditor(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const labelChip = page.getByTestId(`standout-label-${target.id}`);
    const labelLayout = async () => labelChip.evaluate(element => {
        const title = element.closest('.standout-title-row')?.querySelector('[data-embed-nav-title]');
        if (!title) return null;
        const titleRect = title.getBoundingClientRect();
        const labelRect = element.getBoundingClientRect();
        return { gap: labelRect.left - titleRect.right, width: labelRect.width };
    });
    await labelChip.hover();
    expect((await labelLayout())!.gap).toBeLessThan(40);
    expect((await labelLayout())!.width).toBeGreaterThan(300);
    await expect(labelChip).toHaveAttribute('title', new RegExp('Right-click to copy label'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await labelChip.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Standout label actions' });
    await expect(menu).toContainText(label);
    await menu.getByRole('menuitem', { name: 'Copy full label' }).click();
    await expect(menu.getByRole('menuitem')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(label);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.getByTestId(`embedded-editor-host-${target.id}`)).toBeHidden();
    await labelChip.click();
    await expect(page.getByTestId(`embedded-editor-host-${target.id}`)).toBeVisible();
    expect((await labelLayout())!.gap).toBeLessThan(40);
    expect((await labelLayout())!.width).toBeGreaterThan(300);
    await labelChip.hover();
    await labelChip.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(page.getByTestId(`embedded-editor-host-${target.id}`)).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(menu).toBeHidden();
});

test('long standout titles take space before the label grows', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    const suffix = Date.now();
    const label = `test:long-title-${'shared-'.repeat(20)}${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: { title: 'For every countable collection of nonoverlapping closed cubes, the sum of their measures equals the measure of the union', label, content: 'Body' }
    })).json() as { id: string };
    const sourceLabel = `test:long-title-source-${suffix}`;
    await page.request.post('/api/blocks', { data: { title: 'Source', label: sourceLabel, content: `[[@${label}]]` } });
    await openEditor(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const labelChip = page.getByTestId(`standout-label-${target.id}`);
    await labelChip.hover();
    const layout = await labelChip.evaluate(element => {
        const row = element.closest('.standout-title-row')!;
        const content = element.closest('.standout-title-content')!;
        const title = row.querySelector('[data-embed-nav-title]')!;
        return {
            row: row.getBoundingClientRect().width,
            content: content.getBoundingClientRect().width,
            title: title.getBoundingClientRect().width,
            label: element.getBoundingClientRect().width
        };
    });
    expect(layout.title).toBeGreaterThan(layout.row * 0.65);
    expect(layout.label).toBeGreaterThanOrEqual(layout.content * 0.05 - 1);
    expect(layout.label).toBeLessThan(layout.row * 0.3);
});

test('preserves safe image names with spaces and encodes portable references', () => {
    expect(validateAssetPath('proof images/complex % result.gif')).toBeNull();
    expect(validateAssetPath('../outside.gif')).not.toBeNull();
    expect(validateAssetPath('folder/bad:name.gif')).not.toBeNull();
    expect(encodedAssetReference('proof images/complex % result.gif'))
        .toBe('assets/proof%20images/complex%20%25%20result.gif');
    expect(decodedAssetPath('assets/proof%20images/complex%20%25%20result.gif'))
        .toBe('assets/proof images/complex % result.gif');
    expect(imageReference('proof images/result.gif', '500', 'a "proof"'))
        .toBe('<img src="assets/proof%20images/result.gif" width="500" alt="a &quot;proof&quot;" />');
    const sized = imageReference('proof images/result.gif', '50%', '', { width: 800, height: 400 });
    expect(sized).toBe('<img src="assets/proof%20images/result.gif" width="50%" data-natural-width="800" data-natural-height="400" />');
    expect(scanImageReferences(sized)[0].geometry).toEqual({ width: 800, height: 400 });
    expect(scanImageReferences('<img src="assets/old.png" data-natural-width="0" data-natural-height="400" />')[0].geometry).toBeUndefined();
});

test('enforces image formats and backend-specific upload limits', () => {
    expect(imageUploadLimit('google')).toBe(5 * 1024 * 1024);
    expect(imageUploadLimit('server')).toBe(12 * 1024 * 1024);
    expect(validateImageUpload({ type: 'image/svg+xml', size: 100 }, 'server')).toContain('PNG');
    expect(validateImageUpload({ type: 'image/png', size: 13 * 1024 * 1024 }, 'server')).toContain('12 MB');
    expect(imageSignatureMatches(Uint8Array.from([71, 73, 70, 56, 57, 97]), 'image/gif')).toBe(true);
    expect(imageSignatureMatches(Uint8Array.from([60, 115, 118, 103]), 'image/gif')).toBe(false);
    expect(validateImageFilename('figures/result.png', 'image/jpeg')).toContain('.jpg');
    expect(validateImageFilename('figures/result.jpeg', 'image/jpeg')).toBeNull();
    expect(imageSignatureMatches(Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 105, 102, 49, 0, 0, 0, 0, 97, 118, 105, 102]), 'image/avif')).toBe(true);
});

test('parses HTML and Markdown image references without losing legacy syntax', () => {
    const html = '<img alt="a > b" width=\'50%\' src=\'assets/proof%20images/result.png\' />';
    expect(scanImageReferences(html)).toEqual([{
        from: 0, to: html.length, src: 'assets/proof%20images/result.png', width: '50%'
    }]);
    const markdown = 'before ![plot](assets/plot_(1).png "caption") after';
    expect(scanImageReferences(markdown)).toEqual([{
        from: 7, to: markdown.length - 6, src: 'assets/plot_(1).png', width: ''
    }]);
    const legacy = '<img src="/api/assets/old image.gif" width="300"/>';
    expect(scanImageReferences(legacy)[0].src).toBe('/api/assets/old image.gif');
    expect(scanImageReferences('![plot [detail]](assets/plot\\(2\\).png)')[0].src)
        .toBe('assets/plot(2).png');
});

test('does not render or rewrite image examples inside Markdown code', () => {
    const content = 'Outside <img src="assets/old.png" />\n\n`![inline](assets/old.png)`\n\n```html\n<img src="assets/old.png" />\n```\n\n    ![indented](assets/old.png)';
    expect(scanImageReferences(content)).toHaveLength(1);
    const moved = replaceAssetImageReferences(content, 'assets/old.png', 'assets/new.png');
    expect(moved.references).toHaveLength(1);
    expect(moved.content).toBe(content.replace('Outside <img src="assets/old.png" />', 'Outside <img src="assets/new.png" />'));
});

test('renders an image reference beside fenced image source without replacing the example', async ({ page, request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    expect((await request.post('/api/assets', { data: { filePath: 'assets/code-example.gif', content: gif } })).ok()).toBeTruthy();
    const editor = await openEditor(page);
    const content = '```html\n<img src="assets/code-example.gif" />\n```\n\n<img src="assets/code-example.gif" />';
    await editor.fill(content);
    await editor.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        EditorView.findFromDOM(element.closest('.cm-editor')!).dispatch({ selection: { anchor: 0 } });
    });
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-image-widget')).toHaveCount(1);
    await expect(editor).toContainText('<img src="assets/code-example.gif" />');
});

test('moves only image source spans, preserving captions, attributes, and unrelated text', () => {
    const source = `before <img width='50%' src='assets/old%20image.gif?v=1&amp;view=1' alt='old image' />\n![caption](<assets/old%20image.gif> "title")\nassets/old image.gif`;
    const result = replaceAssetImageReferences(source, 'assets/old image.gif', 'assets/new folder/new image.gif');
    expect(result.references).toHaveLength(2);
    expect(result.content).toBe(`before <img width='50%' src='assets/new%20folder/new%20image.gif?v=1&amp;view=1' alt='old image' />\n![caption](<assets/new%20folder/new%20image.gif> "title")\nassets/old image.gif`);
    const plan = buildAssetMovePlan([{ id: 'note', title: 'Proof', label: 'proof', content: source }],
        ['assets/old image.gif'], 'assets/old image.gif', 'assets/new folder/new image.gif', 'version');
    expect(plan.impacts).toMatchObject([{ blockId: 'note', count: 2 }]);
    expect(plan.conflicts.join(' ')).toContain('outside a supported image reference');
    expect(buildAssetMovePlan([{ id: 'note', title: 'Proof', label: 'proof', content: source.slice(0, source.lastIndexOf('\n')) }],
        ['assets/old image.gif'], 'assets/old image.gif', 'assets/new folder/new image.gif', 'version').conflicts).toEqual([]);
    expect(buildAssetMovePlan([], ['assets/old image.gif', 'assets/new.gif'], 'assets/old image.gif', 'assets/new.gif', '').conflicts).toContain('An asset already exists at the destination (names may be case-insensitive).');
    expect(buildAssetMovePlan([], ['assets/old image.gif'], 'assets/old image.gif', 'assets/new.png', '').conflicts).toContain('Keep the original file extension; renaming does not convert an image.');
    expect(buildAssetMovePlan([{ id: 'link', title: 'Other link', label: 'link', content: '[file](assets/old%20image.gif)' }],
        ['assets/old image.gif'], 'assets/old image.gif', 'assets/new.gif', '').conflicts.join(' ')).toContain('outside a supported image reference');
});

test('bounds retained embedded editor lifecycle records', () => {
    resetEmbeddedEditorLifecycle();
    for (let index = 0; index < 1_200; index += 1) {
        initialEmbeddedEditorPhase(`["occurrence-${index}"]`);
    }
    const state = getEmbeddedEditorLifecycleStateForTests();
    expect(state.occurrences).toBeLessThanOrEqual(state.maximumOccurrences);
    resetEmbeddedEditorLifecycle();
});

test('retains measured geometry only across lazy hydration, not edits or toggles', () => {
    const before = {
        root: { id: 'root', title: 'Root', content: '[[child∨]]' },
        child: { id: 'child', title: 'Child', content: null }
    };
    const loaded = { ...before, child: { ...before.child, content: 'child text\n[[leaf∨]]' },
        leaf: { id: 'leaf', title: 'Leaf', content: null } };
    expect(isEmbeddedLayoutHydration(before, loaded)).toBe(true);
    expect(isEmbeddedLayoutHydration(loaded, { ...loaded, child: { ...loaded.child, content: 'edited' } })).toBe(false);
    expect(isEmbeddedLayoutHydration(before, { ...loaded, root: { ...before.root, content: '[[child]]' } })).toBe(false);
    expect(isEmbeddedLayoutHydration(before, { ...loaded, child: { ...loaded.child, title: 'Renamed' } })).toBe(false);
    expect(isEmbeddedLayoutHydration(before, { ...loaded, child: { ...loaded.child, id: 'replacement' } })).toBe(false);
    expect(isEmbeddedLayoutHydration(loaded, before)).toBe(false);
});

async function expectCaretToOverlapRow(caret: Locator, row: Locator, tolerance = 2) {
    await expect.poll(async () => {
        const [caretRect, rowRect] = await Promise.all([
            caret.evaluate(element => element.getBoundingClientRect().toJSON()),
            row.evaluate(element => element.getBoundingClientRect().toJSON())
        ]);
        return caretRect.top < rowRect.bottom + tolerance
            && caretRect.bottom > rowRect.top - tolerance;
    }).toBe(true);
}

test('first-run guide teaches core workflows and all its example links resolve', async ({ request, page }) => {
    const response = await request.get('/api/blocks');
    expect(response.ok()).toBeTruthy();
    const blocks = await response.json() as { id: string, title: string, label: string, content: string }[];
    const byLabel = new Map(blocks.map(block => [block.label, block]));
    const welcome = byLabel.get('showcase:main');
    expect(welcome?.title).toBe('Welcome to Math Note Editor');
    expect(welcome?.content).toContain('Cmd/Ctrl+K');
    expect(welcome?.content).toContain('Markdown like syntax are also supported:');
    expect(welcome?.content).toContain('* **Bold**\n* *Italic*\n* _underline_');
    expect(welcome?.content).toContain('> You may also use > at the start.');
    expect(byLabel.get('showcase:features')?.content).toContain('Manage Assets');
    expect(byLabel.get('showcase:features')?.content).toContain('Cmd/Ctrl+I');
    expect(byLabel.get('showcase:discover')?.content).toContain('backlinks count');
    expect(byLabel.get('showcase:discover')?.content).toContain('Blocks View');
    expect(byLabel.get('showcase:math')?.content).toContain('$x^2+y^2=1$');
    expect(byLabel.get('showcase:math')?.content).toContain('\\[\na^2+b^2=c^2\n\\]');
    for (const block of blocks) {
        expect(block.content, `${block.label} should not show raw inline-code backticks in the guide`).not.toContain('`');
        for (const link of parseEmbeddedLinks(block.content)) {
            expect(byLabel.has(resolveEmbeddedLabel(link, block.label)),
                `${block.label} links to missing ${link.label}`).toBe(true);
        }
    }

    await openEditor(page);
    await expect(page.locator('h1')).toContainText('Math Note Editor');
    await expect(page.getByRole('button', { name: 'Google Drive', exact: true })).toHaveText('');
    await expect(page.getByRole('button', { name: 'Read-Only Viewer' })).toHaveText('');
    const searchButton = page.getByRole('button', { name: 'Search', exact: true });
    await expect(searchButton).toHaveText('');
    await expect(searchButton).toHaveAttribute('title', /^Search \(.+\)$/);
    await expect(page.getByText('Start here', { exact: true })).toBeVisible();
    const embedded = byLabel.get('showcase:embed-1');
    expect(embedded).toBeDefined();
    const embeddedHost = () => page.getByTestId(`embedded-editor-host-${embedded!.id}`);
    await expect(embeddedHost().getByText('This text belongs to a separate note.', { exact: false }).first()).toBeVisible();
    const embeddedTitle = page.getByText('An embedded note you can edit', { exact: true });
    await embeddedTitle.click();
    await expect(embeddedHost()).toHaveCount(0);
    await embeddedTitle.click();
    await expect(embeddedHost().getByText('This text belongs to a separate note.', { exact: false }).first()).toBeVisible();
    await page.getByText('Math', { exact: true }).click();
    const inlineFormula = page.locator('.cm-math-inline').first();
    await expect(inlineFormula).toBeVisible();
    await inlineFormula.click();
    await expect(page.locator('.cm-content').filter({ hasText: 'Inline math' }).first())
        .toContainText('$x^2+y^2=1$');
    await page.locator('.cm-math-block.cm-math-rendered').first().click();
    await expect(page.locator('.cm-content').filter({ hasText: 'Display math' }).last())
        .toContainText('\\[a^2+b^2=c^2\\]');
});

test('derives references from content without persisting duplicate metadata', async ({ request }) => {
    const content = '[[target]] [[target || Alias]] [[/child∨]] [[@standout]]';
    expect(computeReferences(content)).toEqual(['target', '/child', 'standout']);
    expect(stringifyFrontmatter({
        id: 'reference-test',
        title: 'Reference test',
        label: 'reference-test',
        references: ['stale-value']
    }, content)).not.toContain('references:');

    const created = await (await request.post('/api/blocks', {
        data: { title: 'Reference test', label: 'reference-test', content }
    })).json();
    expect(created.references).toEqual(['target', '/child', 'standout']);

    const metadata = await (await request.get('/api/blocks?metaOnly=true')).json();
    expect(metadata.find((block: { id: string }) => block.id === created.id)?.references)
        .toEqual(['target', '/child', 'standout']);
});

test('builds backlinks and line excerpts for absolute, aliased, standout, and relative references', () => {
    const blocks = [
        { id: 'target', title: 'Target', label: 'topic/result', references: [] },
        { id: 'absolute', title: 'Absolute', label: 'notes/absolute', references: ['topic/result'] },
        { id: 'relative', title: 'Relative', label: 'topic', references: ['/result'] },
        { id: 'other', title: 'Other', label: 'notes/other', references: ['elsewhere'] }
    ];
    expect(buildBacklinkIndex(blocks)['topic/result']).toEqual(['absolute', 'relative']);

    const content = [
        'First use: [[topic/result || the main result]].',
        'Unrelated [[elsewhere]].',
        'Second use: [[@topic/result]].'
    ].join('\n');
    expect(findBacklinkOccurrences(content, 'notes/absolute', 'topic/result').map(item => item.line)).toEqual([
        'First use: [[topic/result || the main result]].',
        'Second use: [[@topic/result]].'
    ]);
    expect(findBacklinkOccurrences('Relative use: [[/result]].', 'topic', 'topic/result')).toHaveLength(1);
});

test('derives block-map hierarchy, references, broken targets, and health states', () => {
    const model = buildBlockMapModel([
        { id: 'root', title: 'Root', label: 'analysis', hasContent: true, references: [] },
        { id: 'child', title: 'Child', label: 'analysis/child', hasContent: false, references: ['/result', 'missing'] },
        { id: 'result', title: 'Result', label: 'analysis/child/result', hasContent: true, references: ['analysis'] },
        { id: 'orphan', title: 'Orphan', label: 'detached', hasContent: true, references: [] },
        { id: 'duplicate-a', title: 'Duplicate A', label: 'duplicate', hasContent: true, references: [] },
        { id: 'duplicate-b', title: 'Duplicate B', label: 'duplicate', hasContent: true, references: [] }
    ]);

    expect(model.nodeById.child.parentId).toBe('root');
    expect(model.nodeById.result.parentId).toBe('child');
    expect(model.nodeById.child.outgoingIds).toEqual(['result']);
    expect(model.nodeById.root.incomingIds).toEqual(['result']);
    expect(model.nodeById.child.brokenTargets).toEqual(['missing']);
    expect(model.nodeById.child.health).toEqual(expect.arrayContaining(['empty', 'broken']));
    expect(model.nodeById.orphan.health).toContain('orphan');
    expect(model.nodeById['duplicate-a'].health).toContain('duplicate');
});

test('shows grouped backlinks with on-demand excerpts and opens the source block', async ({ page, request }) => {
    const target = await (await request.post('/api/blocks', {
        data: { title: 'Bounded monotone convergence', label: 'analysis/results/monotone', content: 'Target theorem.' }
    })).json();
    const repeated = await (await request.post('/api/blocks', {
        data: {
            title: 'Application with two mentions',
            label: 'analysis/applications',
            content: 'Use [[analysis/results/monotone || convergence]] here.\nUse [[@analysis/results/monotone]] again.'
        }
    })).json();
    await request.post('/api/blocks', {
        data: {
            title: 'Relative source',
            label: 'analysis/results',
            content: 'A relative reference to [[/monotone]] finishes the argument.'
        }
    });
    await request.post('/api/blocks', {
        data: { title: 'Unrelated source', label: 'analysis/unrelated', content: 'See [[showcase:math]].' }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    await page.getByPlaceholder('Search blocks or create new...').fill(target.label);
    await page.getByPlaceholder('Search blocks or create new...').press('Enter');

    const backlinkButton = page.getByTestId('backlinks-button');
    await expect(backlinkButton).toHaveAttribute('aria-label', 'Show 2 backlinks');
    await expect(backlinkButton).toHaveAttribute('title', '2 backlinks');
    await backlinkButton.click();

    const popover = page.getByTestId('backlinks-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByText('Application with two mentions')).toBeVisible();
    await expect(popover.getByText('Relative source')).toBeVisible();
    await expect(popover.getByText('2 mentions')).toBeVisible();
    await expect(popover.getByText('Use [[analysis/results/monotone || convergence]] here.')).toBeVisible();
    await expect(popover.getByText('A relative reference to [[/monotone]] finishes the argument.')).toBeVisible();
    await expect(popover.getByText('Unrelated source')).toHaveCount(0);

    await backlinkButton.click();
    await expect(popover).toHaveCount(0);
    await backlinkButton.click();
    await expect(popover).toBeVisible();

    await page.getByTestId(`backlink-source-${repeated.id}`).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Application with two mentions/ })).toHaveAttribute('aria-selected', 'true');
});

test('ranks empty and typed searches by recency, relevance, and natural label order', () => {
    const blocks = [
        { id: 'title-prefix', title: 'Topology overview', label: 'Notes/Chapter 10' },
        { id: 'label-substring', title: 'Reference', label: 'Notes/My topology reference' },
        { id: 'segment-prefix', title: 'Manifold note', label: 'Math/Topology' },
        { id: 'label-prefix-10', title: 'Later', label: 'Topology/Chapter 10' },
        { id: 'label-prefix-2', title: 'Earlier', label: 'Topology/Chapter 2' },
        { id: 'exact', title: 'Exact', label: 'Topology' },
        { id: 'alphabetical', title: 'Other', label: 'Algebra' }
    ];

    expect(rankSearchResults(blocks, '', ['segment-prefix', 'exact'], 10).map(block => block.id)).toEqual([
        'segment-prefix', 'exact', 'alphabetical', 'title-prefix', 'label-substring', 'label-prefix-2', 'label-prefix-10'
    ]);
    expect(rankSearchResults(blocks, 'topology').map(block => block.id)).toEqual([
        'exact', 'label-prefix-2', 'label-prefix-10', 'segment-prefix', 'title-prefix', 'label-substring'
    ]);
});

test('round-trips special-character labels with math-aware embed syntax', () => {
    const labels = [
        'Divisibility/$a|b$',
        'Norm/$||x||$',
        'Intervals/$[a,b]$',
        'Notes [draft]',
        'A || B',
        '@literal',
        '/literal',
        'logical∨'
    ];
    for (const label of labels) {
        const encoded = encodeEmbeddedLabel(label);
        const parsed = parseEmbeddedLinks(`[[${encoded}]]`);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].label).toBe(label);
        expect(parsed[0].alias).toBeNull();
        expect(parsed[0].standout).toBe(false);
        expect(parsed[0].open).toBe(false);
    }

    const source = 'See [[Norm/$||x||$||Visible $[x,y]$∨]] now';
    expect(parseEmbeddedLinks(source)[0]).toMatchObject({
        label: 'Norm/$||x||$',
        alias: 'Visible $[x,y]$',
        open: true
    });
    expect(computeReferences(source)).toEqual(['Norm/$||x||$']);

    const cursor = source.indexOf('x||$') + 1;
    expect(findActiveEmbeddedTarget(source, cursor)?.label).toBe('Norm/$||x||$');

    const tooltipSource = String.raw`Thus $x \tooltip{=}{See [[proof:inside-math]].} y$`;
    const tooltipCursor = tooltipSource.indexOf('inside-math') + 4;
    expect(findActiveEmbeddedTarget(tooltipSource, tooltipCursor, { allowUnclosed: false })).toBeNull();
    expect(findActiveEmbeddedTarget(tooltipSource, tooltipCursor, { allowInsideMath: true })).toMatchObject({
        label: 'proof:inside-math',
        relative: false,
        standout: false
    });
    // The fallback scans earlier [[ tokens. At column zero it must terminate
    // rather than searching from -1, which String.lastIndexOf clamps to zero.
    expect(findActiveEmbeddedTarget('[[target]] suffix', 17, {
        allowUnclosed: false,
        allowInsideMath: true
    })).toBeNull();
});

test('round-trips YAML metadata and creates bounded readable filenames', () => {
    const title = 'Definition: $A[1]$ # important 🧮';
    const label = 'Topology/Hausdorff/Definition $A[1]$';
    const markdown = stringifyFrontmatter({ id: 'f26157d5', title, label, references: ['stale'] }, 'Body');
    const parsed = parseFrontmatter(markdown);
    expect(metadataText(parsed.data.title)).toBe(title);
    expect(metadataText(parsed.data.label)).toBe(label);
    expect(markdown).not.toContain('references:');

    const filename = makeBlockFilename(title, label, 'f26157d5');
    expect(filename).toContain('Definition');
    expect(filename).toContain('Hausdorff');
    expect(filename).toContain('f26157d5');
    expect(new TextEncoder().encode(filename).length).toBeLessThan(255);
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);
});

test('plans a sparse subtree relabel and preserves relative link meaning', () => {
    const blocks = [
        { id: 'root', title: 'Sparse root', label: 'A/B', content: 'Child [[/Child]]' },
        { id: 'child', title: 'Child', label: 'A/B/Child', content: '' },
        { id: 'source', title: 'Index', label: 'Index', content: 'See [[A/B/Child||Child alias∨]] and [[A/B/Future]]' }
    ];
    const plan = buildSafeRelabelPlan(blocks, 'A/B', 'Math/Groups');

    expect(plan.changeType).toBe('move-and-rename');
    expect(plan.conflicts).toEqual([]);
    expect(plan.blockChanges.map(change => [change.oldLabel, change.newLabel])).toEqual([
        ['A/B', 'Math/Groups'],
        ['A/B/Child', 'Math/Groups/Child']
    ]);
    expect(plan.referenceImpacts.find(impact => impact.oldText === '[[/Child]]')).toMatchObject({
        changed: false,
        oldTarget: 'A/B/Child',
        newTarget: 'Math/Groups/Child'
    });
    expect(plan.referenceImpacts.find(impact => impact.oldTarget === 'A/B/Future')).toMatchObject({
        changed: true,
        targetExists: false,
        newText: '[[Math/Groups/Future]]'
    });

    const applied = applySafeRelabelPlan(blocks, plan);
    expect(applied.find(block => block.id === 'root')?.content).toBe('Child [[/Child]]');
    expect(applied.find(block => block.id === 'source')?.content)
        .toBe('See [[Math/Groups/Child||Child alias∨]] and [[Math/Groups/Future]]');
});

test('safe relabel signature is stable when workspace enumeration order changes', () => {
    const blocks = [
        { id: 'root', title: 'Root', label: 'A/B', content: '[[/Child]]' },
        { id: 'child', title: 'Child', label: 'A/B/Child', content: '' },
        { id: 'source', title: 'Source', label: 'Index', content: '[[A/B]] [[A/B/Child]]' }
    ];
    const forward = buildSafeRelabelPlan(blocks, 'A/B', 'X/B');
    const reversed = buildSafeRelabelPlan([...blocks].reverse(), 'A/B', 'X/B');
    expect(relabelPlanSignatureInput(forward)).toBe(relabelPlanSignatureInput(reversed));
});

test('rejects relabel collisions and moving a node into its own subtree', () => {
    const blocks = [
        { id: 'one', title: 'One', label: 'A/B', content: '' },
        { id: 'child', title: 'Child', label: 'A/B/C', content: '' },
        { id: 'occupied', title: 'Occupied', label: 'X/B/C', content: '' }
    ];
    expect(buildSafeRelabelPlan(blocks, 'A/B', 'X/B').conflicts.join(' ')).toContain('already occupied');
    expect(buildSafeRelabelPlan(blocks, 'A/B', 'A/B/Nested').conflicts.join(' ')).toContain('own subtree');
});

test('previews and commits a revision-checked tree transformation', async ({ request }) => {
    const suffix = Date.now();
    const oldPrefix = `safe-${suffix}/missing-parent`;
    const newPrefix = `moved-${suffix}/new-parent`;
    const root = await (await request.post('/api/blocks', {
        data: { title: 'Safe root', label: oldPrefix, content: 'child [[/Child]]' }
    })).json();
    const child = await (await request.post('/api/blocks', {
        data: { title: 'Safe child', label: `${oldPrefix}/Child`, content: '' }
    })).json();
    const source = await (await request.post('/api/blocks', {
        data: { title: 'Safe source', label: `source-${suffix}`, content: `before [[${oldPrefix}/Child]] after` }
    })).json();

    const previewResponse = await request.post('/api/relabel/preview', { data: { oldPrefix, newPrefix } });
    expect(previewResponse.ok()).toBeTruthy();
    const preview = await previewResponse.json();
    expect(preview.conflicts).toEqual([]);
    expect(preview.blockChanges).toHaveLength(2);
    expect(preview.referenceImpacts.some((impact: { changed: boolean }) => impact.changed)).toBeTruthy();

    const commit = await request.post('/api/relabel/commit', {
        data: { oldPrefix, newPrefix, revision: preview.revision }
    });
    expect(commit.ok()).toBeTruthy();
    expect((await (await request.get(`/api/blocks/${root.id}`)).json()).label).toBe(newPrefix);
    expect((await (await request.get(`/api/blocks/${child.id}`)).json()).label).toBe(`${newPrefix}/Child`);
    expect((await (await request.get(`/api/blocks/${source.id}`)).json()).content).toContain(`[[${newPrefix}/Child]]`);
});

test('rejects stale relabel plans and direct label-change bypasses', async ({ request }) => {
    const suffix = Date.now();
    const oldPrefix = `stale-${suffix}`;
    const newPrefix = `fresh-${suffix}`;
    const block = await (await request.post('/api/blocks', {
        data: { title: 'Stale plan', label: oldPrefix, content: '' }
    })).json();
    const preview = await (await request.post('/api/relabel/preview', {
        data: { oldPrefix, newPrefix }
    })).json();

    const directRelabel = await request.put(`/api/blocks/${block.id}`, {
        data: { ...block, label: newPrefix }
    });
    expect(directRelabel.status()).toBe(409);
    expect((await directRelabel.json()).error).toContain('reviewed tree transformation');

    const titleUpdate = await request.put(`/api/blocks/${block.id}`, {
        data: { ...block, title: 'Changed after preview' }
    });
    expect(titleUpdate.ok()).toBeTruthy();
    const staleCommit = await request.post('/api/relabel/commit', {
        data: { oldPrefix, newPrefix, revision: preview.revision }
    });
    expect(staleCommit.status()).toBe(409);
    expect((await staleCommit.json()).error).toContain('workspace changed');
});

test('rejects invalid and duplicate labels at the server boundary', async ({ request }) => {
    const validLabel = `special/$A[1]|B$-${Date.now()}`;
    const created = await request.post('/api/blocks', {
        data: { title: 'Special label', label: validLabel, content: '' }
    });
    expect(created.ok()).toBeTruthy();

    const duplicate = await request.post('/api/blocks', {
        data: { title: 'Duplicate', label: validLabel, content: '' }
    });
    expect(duplicate.status()).toBe(409);

    for (const label of ['@reserved', '/reserved', 'bad\nlabel', `bad\u200blabel`, 'x'.repeat(513)]) {
        expect(validateBlockLabel(label)).not.toBeNull();
        const response = await request.post('/api/blocks', {
            data: { title: 'Invalid', label, content: '' }
        });
        expect(response.status()).toBe(400);
    }
});

test('rejects concurrent attempts to create the same label', async ({ request }) => {
    const label = `test:concurrent-create-${Date.now()}`;
    const responses = await Promise.all([
        request.post('/api/blocks', { data: { title: 'Concurrent A', label, content: '' } }),
        request.post('/api/blocks', { data: { title: 'Concurrent B', label, content: '' } })
    ]);
    expect(responses.map(response => response.status()).sort()).toEqual([200, 409]);
});

test('groups normalized duplicate labels without assigning either block as canonical', () => {
    const issues = findDuplicateLabelIssues([
        { id: 'one', title: 'One', label: ' Shared ', fileName: 'one.md' },
        { id: 'two', title: 'Two', label: 'Shared', fileName: 'two.md' },
        { id: 'three', title: 'Three', label: 'Unique', fileName: 'three.md' }
    ]);
    expect(issues).toEqual([{
        label: 'Shared',
        blocks: [
            { id: 'one', title: 'One', label: 'Shared', fileName: 'one.md' },
            { id: 'two', title: 'Two', label: 'Shared', fileName: 'two.md' }
        ]
    }]);
});

test('pauses duplicate blocks and repairs one through the workspace issues flow', async ({ page, request }) => {
    const label = `duplicate-import-${Date.now()}`;
    const seeded = await request.post('/api/test/duplicate-labels', { data: { label } });
    expect(seeded.ok()).toBeTruthy();

    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Duplicate labels need attention' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText(/duplicate label group needs attention/i)).toBeVisible();

    await dialog.getByRole('button', { name: 'Open to rename' }).first().click();
    const repairedLabel = `${label}-repaired`;
    await page.getByLabel('Block label').fill(repairedLabel);
    await page.getByLabel('Save block metadata').click();
    await page.getByRole('dialog', { name: 'Repair label' }).getByRole('button', { name: 'Repair label' }).click();

    await expect(page.getByText(/duplicate label group needs attention/i)).not.toBeVisible();
    const metadata = await (await request.get('/api/blocks?metaOnly=true')).json();
    expect(metadata.filter((block: { label: string }) => block.label === label)).toHaveLength(1);
    expect(metadata.filter((block: { label: string }) => block.label === repairedLabel)).toHaveLength(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('dialog', { name: /^Undo Repair label/ }).getByRole('button', { name: 'Undo' }).click();
    await expect(dialog).toBeVisible();
    const restored = await (await request.get('/api/blocks?metaOnly=true')).json();
    expect(restored.filter((block: { label: string }) => block.label === label)).toHaveLength(2);
    await dialog.getByRole('button', { name: 'Review later' }).click();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByRole('dialog', { name: /^Redo Repair label/ }).getByRole('button', { name: 'Redo' }).click();
    await expect(dialog).toBeHidden();
});

test('creates an exact safe search label and focuses the new root editor', async ({ page }) => {
    const label = `Mixed Case Search Label [${Date.now()}]`;
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(label);
    await expect(page.getByText(`Create "${label}"`, { exact: true })).toBeVisible();
    await search.press('Enter');

    const confirmation = page.getByRole('dialog', { name: 'Create new block?' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(label);
    await expect(confirmation.getByRole('button', { name: 'Create block' })).toBeFocused();
    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.some((block: { label: string }) => block.label === label);
    }).toBe(false);
    await confirmation.getByRole('button', { name: 'Create block' }).click();

    await expect(search).not.toBeVisible();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(label);
    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.some((block: { label: string }) => block.label === label);
    }).toBe(true);
});

test('cancels block creation from search without closing the search', async ({ page }) => {
    const label = `Cancel Search Creation ${Date.now()}`;
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(label);
    await page.getByText(`Create "${label}"`, { exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Create new block?' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(search).toBeFocused();
    await search.press('Enter');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Create block' }).press('Escape');
    await expect(confirmation).not.toBeVisible();
    await expect(search).toBeFocused();
    const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    expect(metadata.some((block: { label: string }) => block.label === label)).toBe(false);
});

test('keeps invalid search creation open and does not create a block', async ({ page }) => {
    const invalidLabel = `@invalid-search-${Date.now()}`;
    await openEditor(page);
    const before = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(invalidLabel);
    await expect(page.getByText(/Label cannot start with @/)).toBeVisible();
    await search.press('Enter');

    await expect(search).toBeVisible();
    await expect(page.getByText(/Label cannot start with @/)).toBeVisible();
    const after = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    expect(after).toHaveLength(before.length);
});

test('validates header metadata and accepts brackets and math in labels', async ({ page }) => {
    await openEditor(page);
    const previousPanelId = await page.getByRole('tab', { selected: true }).getAttribute('aria-controls');
    await page.getByLabel('Create new block').click();
    await page.getByRole('dialog', { name: 'Create note' }).getByRole('button', { name: 'Create note' }).click();
    await expect.poll(() => page.getByRole('tab', { selected: true }).getAttribute('aria-controls')).not.toBe(previousPanelId);
    const activePanelId = await page.getByRole('tab', { selected: true }).getAttribute('aria-controls');
    expect(activePanelId).toBeTruthy();
    const header = page.locator(`#${activePanelId} [data-testid^="block-metadata-header-"]`);
    await header.dblclick();

    await page.getByLabel('Block label').fill('bad\u200blabel');
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText(/Label cannot contain line breaks/)).toBeVisible();

    await page.getByLabel('Block label').fill('@reserved');
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText(/Label cannot start with @/)).toBeVisible();

    await page.getByLabel('Block label').fill('/reserved');
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText(/Label cannot start with \//)).toBeVisible();

    const validTitle = 'Intervals $[a,b]$';
    const validLabel = `Analysis/Intervals/$[a,b]|c$-${Date.now()}`;
    await page.getByLabel('Block title').fill(validTitle);
    await page.getByLabel('Block label').fill(validLabel);
    await page.getByLabel('Save block metadata').click();
    await expect(page.getByText('Tree transformation', { exact: true })).toBeVisible();
    await expect(page.getByText('Block label changes', { exact: false })).toBeVisible();
    await expect(page.getByText(validLabel, { exact: true }).first()).toBeVisible();
    const commitResponse = page.waitForResponse(response => response.url().endsWith('/api/relabel/commit') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Move and rename subtree/ }).click();
    expect((await commitResponse).ok()).toBeTruthy();
    await expect(page.getByText('Tree transformation complete')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    const savedBlockId = activePanelId!.replace('block-tab-panel-', '');
    await expect.poll(async () => {
        const response = await page.request.get(`/api/blocks/${savedBlockId}`);
        return await response.json();
    }).toMatchObject({ title: validTitle, label: validLabel });
});

test('keeps root metadata readable with a long label and compact secondary actions', async ({ page }) => {
    const suffix = Date.now();
    const title = 'countable subadditivity';
    const label = `Unsorted Notes/Analysis I/Lebesgue measure in $\\mathbb{R}^n$/countable subadditivity-${suffix}`;
    const block = await (await page.request.post('/api/blocks', {
        data: { title, label, content: 'Header layout content' }
    })).json();

    await page.setViewportSize({ width: 760, height: 900 });
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    await page.getByPlaceholder('Search blocks or create new...').fill(label);
    await page.getByPlaceholder('Search blocks or create new...').press('Enter');

    const header = page.getByTestId(`block-metadata-header-${block.id}`);
    const visibleTitle = header.locator('[data-find-visible-title="true"]');
    const visibleLabel = page.getByTestId(`block-visible-label-${block.id}`);
    await expect(visibleTitle).toHaveText(title);
    await expect(visibleLabel).toHaveAttribute('title', label);
    await expect(visibleLabel).toHaveAttribute('data-label-clamped', 'true');
    await expect(visibleLabel).toContainText(/^…/);
    const geometry = await header.evaluate(element => {
        const titleElement = element.querySelector<HTMLElement>('[data-find-visible-title="true"]')!;
        const labelElement = element.querySelector<HTMLElement>('[data-find-visible-label="true"]')!;
        const titleRect = titleElement.getBoundingClientRect();
        const labelRect = labelElement.getBoundingClientRect();
        return {
            headerFits: element.scrollWidth <= element.clientWidth + 1,
            titleHeight: titleRect.height,
            titleLineHeight: parseFloat(getComputedStyle(titleElement).lineHeight),
            labelBelowTitle: labelRect.top >= titleRect.bottom - 1,
            labelTextAlign: getComputedStyle(labelElement).textAlign,
            labelStartsAtLeft: Math.abs(labelElement.getBoundingClientRect().left - labelElement.parentElement!.getBoundingClientRect().left) < 2
        };
    });
    expect(geometry.headerFits).toBe(true);
    expect(geometry.titleHeight).toBeLessThanOrEqual(geometry.titleLineHeight * 1.2);
    expect(geometry.labelBelowTitle).toBe(true);
    expect(geometry.labelTextAlign).toBe('left');
    expect(geometry.labelStartsAtLeft).toBe(true);

    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(visibleLabel).toHaveAttribute('data-label-clamped', 'false');
    await expect(visibleLabel).toHaveText(label);
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(visibleLabel).toHaveAttribute('data-label-clamped', 'true');

    await header.getByRole('button', { name: 'More block actions' }).click();
    await expect(header.getByText('View raw Markdown', { exact: true })).toBeVisible();
    await expect(header.getByText('Delete note…', { exact: true })).toBeVisible();
    await header.getByRole('button', { name: 'More block actions' }).click();

    await visibleTitle.dblclick();
    const titleInput = page.getByLabel('Block title');
    const labelInput = page.getByLabel('Block label');
    await expect(titleInput).toHaveValue(title);
    await expect(labelInput).toHaveValue(label);
    const editingGeometry = await header.evaluate(element => {
        const titleElement = element.querySelector<HTMLElement>('[aria-label="Block title"]')!;
        const labelElement = element.querySelector<HTMLElement>('[aria-label="Block label"]')!;
        const titleRect = titleElement.getBoundingClientRect();
        const labelRect = labelElement.getBoundingClientRect();
        return {
            headerFits: element.scrollWidth <= element.clientWidth + 1,
            labelBelowTitle: labelRect.top >= titleRect.bottom - 1
        };
    });
    expect(editingGeometry).toEqual({ headerFits: true, labelBelowTitle: true });
    await page.getByLabel('Cancel block metadata editing').click();
});

test('edits active block metadata with F2 and a customized shortcut', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.press('F2');
    await expect(page.getByLabel('Block title')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Block title')).toBeHidden();

    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Keyboard Shortcuts' }).click();
    const shortcutInput = page.getByLabel('Edit active block metadata shortcut');
    await expect(shortcutInput).toHaveValue('f2');
    await shortcutInput.fill('mod+shift+e');
    await page.getByRole('button', { name: 'Save Settings' }).click();

    await page.keyboard.press('ControlOrMeta+Shift+E');
    await expect(page.getByLabel('Block title')).toBeFocused();
    await page.keyboard.press('Escape');

    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Keyboard Shortcuts' }).click();
    await page.getByLabel('Edit active block metadata shortcut').fill('f2');
    await page.getByRole('button', { name: 'Save Settings' }).click();
});

test('renders an embedded block whose label contains math bars and brackets', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `Norms/$||x[${suffix}]||$`;
    await page.request.post('/api/blocks', {
        data: { title: 'Special-character target', label: targetLabel, content: 'Target content' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Prototype-name target', label: '__proto__', content: 'Prototype target content' }
    });
    const sourceLabel = `special-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Special-character source',
            label: sourceLabel,
            content: `References: [[${targetLabel}]] and [[__proto__]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    await expect(page.getByText('Special-character target', { exact: true })).toBeVisible();
    await expect(page.getByText('Prototype-name target', { exact: true })).toBeVisible();
});

test('keeps a standout title readable while abbreviating a long label from the left', async ({ page }) => {
    const suffix = Date.now();
    const longLabel = `analysis/complex/functions/holomorphic/really-long-branch-${suffix}/derivatives`;
    const target = await (await page.request.post('/api/blocks', {
        data: { title: 'Important theorem title', label: longLabel, content: 'Target content' }
    })).json();
    const sourceLabel = `standout-layout-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Standout layout source', label: sourceLabel, content: `[[@${longLabel}]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    await page.getByPlaceholder('Search blocks or create new...').fill(sourceLabel);
    await page.getByPlaceholder('Search blocks or create new...').press('Enter');

    const title = page.locator('[role="tabpanel"][aria-hidden="false"]').getByText('Important theorem title', { exact: true });
    const label = page.getByTestId(`standout-label-${target.id}`);
    await expect(title).toBeVisible();
    await expect(label).toHaveText(longLabel);
    await expect(label).toHaveAttribute('title', `${longLabel}\nRight-click to copy label`);
    const boxes = await Promise.all([title.boundingBox(), label.boundingBox()]);
    expect(boxes[0]).not.toBeNull();
    expect(boxes[1]).not.toBeNull();
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
});

test('capitalizes only letter-leading standout titles without changing inline titles or stored data', async ({ page }) => {
    const suffix = Date.now();
    const lowercaseLabel = `standout-lowercase-${suffix}`;
    const mathLabel = `standout-math-leading-${suffix}`;
    const punctuationLabel = `standout-punctuation-leading-${suffix}`;
    const lowercase = await (await page.request.post('/api/blocks', {
        data: { title: 'countable subadditivity', label: lowercaseLabel, content: 'Lowercase target content' }
    })).json();
    const math = await (await page.request.post('/api/blocks', {
        data: { title: '$f$ remains lowercase', label: mathLabel, content: 'Math target content' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: '(local) estimate', label: punctuationLabel, content: 'Punctuation target content' }
    });
    const sourceLabel = `standout-capitalization-source-${suffix}`;
    const sourceContent = `[[@${lowercaseLabel}]]\n[[${lowercaseLabel}]]\n[[@${mathLabel}]]\n[[@${punctuationLabel}]]`;
    const source = await (await page.request.post('/api/blocks', {
        data: { title: 'Standout capitalization source', label: sourceLabel, content: sourceContent }
    })).json();

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    await page.getByPlaceholder('Search blocks or create new...').fill(sourceLabel);
    await page.getByPlaceholder('Search blocks or create new...').press('Enter');

    const standoutTitle = page.getByText('Countable subadditivity', { exact: true });
    await expect(standoutTitle).toHaveCount(1);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"]').getByText('countable subadditivity', { exact: true })).toHaveCount(1);
    const mathLeadingTitle = page.locator('[data-embed-nav-title="true"]')
        .filter({ has: page.locator('.katex') })
        .filter({ hasText: 'remains lowercase' });
    await expect(mathLeadingTitle).toHaveCount(1);
    expect(await mathLeadingTitle.textContent()).toContain('remains lowercase');
    expect(await mathLeadingTitle.textContent()).not.toContain('Remains lowercase');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"]').getByText('(local) estimate', { exact: true })).toHaveCount(1);

    await standoutTitle.click();
    await expect(page.getByText('Lowercase target content', { exact: true })).toBeVisible();
    await expect(page.getByText('Countable subadditivity', { exact: true })).toHaveCount(1);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"]').getByText('countable subadditivity', { exact: true })).toHaveCount(1);

    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${lowercase.id}`)).json()).title)
        .toBe('countable subadditivity');
    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${math.id}`)).json()).title)
        .toBe('$f$ remains lowercase');
    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${source.id}`)).json()).content)
        .toBe(sourceContent);
});

test('renders autocomplete with an opaque surface inside an open standout block', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `opaque-menu-target-${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: { title: 'Nested math editor', label: targetLabel, content: '$$' }
    })).json();
    const sourceLabel = `opaque-menu-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Opaque menu source', label: sourceLabel, content: `[[@${targetLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    await page.getByPlaceholder('Search blocks or create new...').fill(sourceLabel);
    await page.getByPlaceholder('Search blocks or create new...').press('Enter');

    const embeddedHost = page.getByTestId(`embedded-editor-host-${target.id}`);
    await expect(embeddedHost).toHaveAttribute('data-editor-mounted', 'true');
    const nestedEditor = embeddedHost.locator('.cm-content');
    await nestedEditor.click();
    await expect(embeddedHost).toHaveAttribute('data-editor-activated', 'true');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.insertText('\\fra');
    await page.keyboard.press('Control+Space');
    const menu = page.locator('.cm-tooltip-autocomplete').last();
    await expect(menu).toBeVisible();
    const appearance = await menu.evaluate(element => {
        const style = getComputedStyle(element);
        const editor = element.closest('.cm-editor');
        return {
            background: style.backgroundColor,
            border: style.borderTopColor,
            editorBackground: editor ? getComputedStyle(editor).backgroundColor : ''
        };
    });
    expect(appearance.background).not.toBe('transparent');
    expect(appearance.background).not.toMatch(/rgba\([^)]*,\s*0(?:\.0+)?\)$/);
    expect(appearance.background).not.toBe(appearance.editorBackground);
    expect(appearance.border).not.toBe(appearance.background);
    const menuOwnsItsPixels = await menu.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height - 4, 100));
        return !!point && element.contains(point);
    });
    expect(menuOwnsItsPixels).toBe(true);
});

test('shows distinguishing link paths and a full-label preview for the keyboard-highlighted option', async ({ page }) => {
    const suffix = Date.now();
    const common = `course/analysis/very-long-shared-branch-${suffix}`;
    const first = `${common}/convergence/proof-${suffix}`;
    const second = `${common}/uniqueness/proof-${suffix}`;
    const mathTitle = String.raw`Proof of $L^2([0,2\pi])$`;
    for (const label of [first, second]) {
        await page.request.post('/api/blocks', {
            data: { title: label === second ? mathTitle : 'Proof', label, content: 'Target content' }
        });
    }

    const editor = await openEditor(page);
    const source = `[[proof-${suffix}]]`;
    await replaceEditorText(page, editor, source);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');

    const menu = page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)');
    await expect(menu).toBeVisible();
    await expect(menu.locator('li')).toHaveCount(3); // Create, then one row per existing block.
    expect(await menu.locator('li .cm-completionIcon').evaluateAll(icons =>
        icons.every(icon => getComputedStyle(icon).display === 'none'))).toBe(true);
    await expect(menu.getByText('… › convergence › proof-' + suffix)).toBeVisible();
    await expect(menu.getByText('… › uniqueness › proof-' + suffix)).toBeVisible();

    const preview = menu.locator('.cm-link-completion-preview');
    await expect(preview.locator('.cm-link-completion-preview-caption')).toHaveText([
        'Title:', 'Full label:', 'Target to insert:'
    ]);
    await expect(preview).toContainText(`Full label:${source.slice(2, -2)}`);
    await expect(preview.locator('.cm-link-completion-preview-title')).toHaveText(`proof-${suffix}`);
    const layout = await menu.evaluate(element => {
        const list = element.querySelector('ul')!.getBoundingClientRect();
        const footer = element.querySelector('.cm-link-completion-footer')!.getBoundingClientRect();
        return { listBottom: list.bottom, footerTop: footer.top, footerBottom: footer.bottom, menuBottom: element.getBoundingClientRect().bottom };
    });
    expect(layout.footerTop).toBeGreaterThanOrEqual(layout.listBottom - 1);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.menuBottom + 1);
    // CM6 deliberately ignores completion-navigation keys for 75 ms after opening.
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await expect(preview).toContainText(`Full label:${first}`);
    await expect(preview.locator('.cm-link-completion-preview-title')).toHaveText('Proof');
    await expect(preview).toContainText(`Target to insert:${first}`);
    await expect(editor).toHaveText(source);
    await page.keyboard.press('ArrowDown');
    await expect(preview).toContainText(`Full label:${second}`);
    await expect(preview.locator('.cm-link-completion-preview-title .katex')).toBeVisible();
    await expect(preview.locator('.cm-link-completion-preview-title')).not.toContainText('$L^2');
    await expect(editor).toHaveText(source);
    await page.keyboard.press('Enter');
    await expect(editor).toHaveText(`[[${second}]]`);
});

test('relative link completion has one option per descendant and previews the resolved full label', async ({ page }) => {
    const suffix = Date.now();
    const parentLabel = `relative-preview-parent-${suffix}`;
    const childLabel = `${parentLabel}/chapter/proof-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Parent', label: parentLabel, content: '' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Proof', label: childLabel, content: 'Target content' }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(parentLabel);
    await search.press('Enter');

    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await replaceEditorText(page, editor, `[[/proof-${suffix}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    const menu = page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)');
    await expect(menu.locator('li')).toHaveCount(2); // Create plus one relative target, not an absolute duplicate.
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('.cm-link-completion-preview')).toContainText(`Full label:${childLabel}`);
    await expect(menu.locator('.cm-link-completion-preview')).toContainText(`Target to insert:/chapter/proof-${suffix}`);
    await page.keyboard.press('Enter');
    await expect(editor).toHaveText(`[[/chapter/proof-${suffix}]]`);
});

test('left-parenthesis completion consumes an existing auto-closed pair', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '$\\left()$');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let index = 0; index < '$\\left'.length; index++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+Space');
    await page.getByText('\\left(', { exact: true }).click();
    await expect(editor).toHaveText('$\\left(\\right)$');
});

test('validates labels created from embed autocomplete', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '[[bad\u200blabel]]');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(page.getByText(/Create new block: "bad/)).toHaveCount(0);

    await replaceEditorText(page, editor, String.raw`[[\/reserved]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(page.getByText('Create new block: "/reserved"', { exact: true })).toHaveCount(0);

    const relativeLabel = `/relative-${Date.now()}`;
    await replaceEditorText(page, editor, `[[${relativeLabel}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(page.getByText(`Create new block: "${relativeLabel}"`, { exact: true })).toBeVisible();

    const suffix = Date.now();
    const validLabel = `New/$A[${suffix}]|B$`;
    await replaceEditorText(page, editor, `[[${validLabel}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    const createOption = page.getByText(`Create new block: "${validLabel}"`, { exact: true });
    await expect(createOption).toBeVisible();
    await createOption.click();
    const createDialog = page.getByRole('dialog', { name: 'Create note' });
    await expect(createDialog).toContainText(validLabel);
    await createDialog.getByRole('button', { name: 'Create note' }).click();

    await expect(editor).toBeFocused();

    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.some((block: { label: string }) => block.label === validLabel);
    }).toBe(true);
});

test('only opens label autocomplete inside a closed embed', async ({ page }) => {
    const editor = await openEditor(page);
    const label = `test:closed-autocomplete-${Date.now()}`;
    const createOption = page.getByText(`Create new block: "${label}"`, { exact: true });

    await replaceEditorText(page, editor, `[[${label}`);
    await page.keyboard.press('Control+Space');
    await expect(createOption).toBeHidden();

    await page.keyboard.insertText(']]');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(createOption).toBeVisible();
});

test('opens label autocomplete inside an inline-math tooltip explanation', async ({ page }) => {
    const editor = await openEditor(page);
    const label = `test:tooltip-autocomplete-${Date.now()}`;
    const source = String.raw`Thus $x \tooltip{=}{See [[]].} y$`;

    await replaceEditorText(page, editor, source);
    const stepsFromEnd = source.length - (source.indexOf('[[') + 2);
    for (let index = 0; index < stepsFromEnd; index++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.insertText(label);

    await expect(page.getByText(`Create new block: "${label}"`, { exact: true })).toBeVisible();
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    await expect(editor).toContainText(String.raw`\tooltip{=}{See [[${label}]].}`);

    // A bracket pair in ordinary TeX remains literal and must not start the
    // note-link completion path.
    await page.keyboard.press('Escape');
    const ordinaryMath = `$x + [[${label}]]$`;
    await replaceEditorText(page, editor, ordinaryMath);
    const ordinaryStepsFromEnd = ordinaryMath.length - (ordinaryMath.indexOf(label) + label.length);
    for (let index = 0; index < ordinaryStepsFromEnd; index++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await expect(page.getByText(`Create new block: "${label}"`, { exact: true })).toBeHidden();
});

test('opens and preserves label autocomplete when entering a broken embed', async ({ page }) => {
    const editor = await openEditor(page);
    const suffix = Date.now();
    const label = `test:broken-entry-${suffix}`;
    const source = `before [[${label}]] after`;
    const completion = page.locator('.cm-tooltip-autocomplete');

    await replaceEditorText(page, editor, source);
    await page.getByText(`[[${label}]]`, { exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(page.getByText(`Create new block: "${label}"`, { exact: true })).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(completion).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(completion).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let index = 0; index < 'before '.length; index++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(completion).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+End');
    for (let index = 0; index < ' after'.length; index++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(completion).toBeVisible();

    await page.getByText(`Create new block: "${label}"`, { exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create note' });
    await expect(createDialog).toContainText(label);
    await createDialog.getByRole('button', { name: 'Create note' }).click();
    await expect(editor).toBeFocused();
    await expect(completion).toBeHidden();
    await expect(page.getByText(/Enter\s+to toggle.*Cmd\/Ctrl \+ Enter.*for new tab/)).toBeVisible();
});

test('opens an existing embedded label in a tab next to the current tab with Mod-Enter', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:mod-enter-target-${suffix}`;
    const currentLabel = `test:mod-enter-current-${suffix}`;
    const trailingLabel = `test:mod-enter-trailing-${suffix}`;
    await page.request.post('/api/blocks', { data: { title: 'Mod Enter target', label: targetLabel, content: 'target' } });
    const currentBlock = await (await page.request.post('/api/blocks', { data: { title: 'Mod Enter current', label: currentLabel, content: `[[${targetLabel}]]` } })).json();
    await page.request.post('/api/blocks', { data: { title: 'Mod Enter trailing', label: trailingLabel, content: 'trailing' } });
    await openEditor(page);

    for (const label of [currentLabel, trailingLabel]) {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    }
    await page.getByRole('tab').filter({ hasText: 'Mod Enter current' }).click();
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ControlOrMeta+Enter');

    const tabs = page.getByRole('tab');
    const titles = await tabs.allTextContents();
    const currentIndex = titles.findIndex(title => title.includes('Mod Enter current'));
    expect(titles[currentIndex + 1]).toContain('Mod Enter target');
    await expect(tabs.filter({ hasText: 'Mod Enter target' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${currentBlock.id}`)).json()).content)
        .toBe(`[[${targetLabel}]]`);
});

test('saves an Enter toggle inside an embedded note without waiting for blur', async ({ page }) => {
    const suffix = Date.now();
    const leafLabel = `test:enter-save-leaf-${suffix}`;
    const childLabel = `test:enter-save-child-${suffix}`;
    const sourceLabel = `test:enter-save-source-${suffix}`;
    const leaf = await (await page.request.post('/api/blocks', {
        data: { title: 'Enter save leaf', label: leafLabel, content: 'leaf body' }
    })).json();
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Enter save child', label: childLabel, content: `[[${leafLabel}∨]]` }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Enter save source', label: sourceLabel, content: `[[${childLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /^Search\b/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const childEditor = page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-content').first();
    await expect(childEditor).toBeVisible();
    await childEditor.focus();
    await expect(childEditor).toBeFocused();
    await childEditor.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        const view = EditorView.findFromDOM(element.closest('.cm-editor')!);
        view.dispatch({ selection: { anchor: 2 } });
    });
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(childEditor).toBeFocused();
    await expect(page.getByTestId(`embedded-editor-host-${leaf.id}`)).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${child.id}`)).json()).content)
        .toBe(`[[${leafLabel}]]`);
});

test('keeps absolute autocomplete titles and derives relative titles from their leaf', async ({ page }) => {
    const suffix = Date.now();
    const parentLabel = `test:relative-title-parent-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Relative title parent', label: parentLabel, content: '' }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(parentLabel);
    await search.press('Enter');

    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    const relativeTarget = `/section/$A/B$-${suffix}`;
    await replaceEditorText(page, editor, `[[${relativeTarget}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    // CodeMirror retains the old menu while restarting completion, but its
    // options cannot be accepted until the refreshed result is active.
    const activeCompletions = page.locator('.cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)');
    await activeCompletions.getByText(`Create new block: "${relativeTarget}"`, { exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create note' });
    await expect(createDialog).toContainText(relativeTarget);
    await createDialog.getByRole('button', { name: 'Create note' }).click();

    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.find((block: { label: string }) => block.label === `${parentLabel}${relativeTarget}`);
    }).toMatchObject({ title: `$A/B$-${suffix}` });

    const absoluteTarget = `abc/def/ghi-${suffix}`;
    await replaceEditorText(page, editor, `[[${absoluteTarget}]]`);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Control+Space');
    await activeCompletions.getByText(`Create new block: "${absoluteTarget}"`, { exact: true }).click();
    await expect(createDialog).toContainText(absoluteTarget);
    await createDialog.getByRole('button', { name: 'Create note' }).click();
    await expect.poll(async () => {
        const metadata = await (await page.request.get('/api/blocks?metaOnly=true')).json();
        return metadata.find((block: { label: string }) => block.label === absoluteTarget);
    }).toMatchObject({ title: absoluteTarget });
});

test('focuses a newly created root after creation from a nested editor', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:create-focus-child-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Create focus child', label: childLabel, content: 'child content' }
    });
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, `[[${childLabel}∨]]`);
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1)).toBeFocused();

    await page.getByLabel('Create new block').click();
    await page.getByRole('dialog', { name: 'Create note' }).getByRole('button', { name: 'Create note' }).click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content')).toHaveCount(1);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
});

test('focuses the root editor when a block is selected through search', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:search-focus-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Search focus target', label: targetLabel, content: 'focus target content' }
    });
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(targetLabel);
    await search.press('Enter');

    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(targetLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
});

test('clicking the workspace background removes editor focus', async ({ page }) => {
    const editor = await openEditor(page);
    await expect(editor).toBeFocused();

    const background = page.locator('[role="tabpanel"][aria-hidden="false"]').filter({ visible: true });
    await expect(background).toBeVisible();
    const box = await background.boundingBox();
    expect(box).not.toBeNull();
    await background.click({ position: { x: 4, y: box!.height - 4 } });

    await expect(editor).not.toBeFocused();
});

test('opens the nearest existing parent beside the current tab by button and custom shortcut', async ({ page }) => {
    const suffix = Date.now();
    const parentLabel = `test:parent-${suffix}`;
    const childLabel = `${parentLabel}/missing/child`;
    await page.request.post('/api/blocks', {
        data: { title: 'Nearest existing parent', label: parentLabel, content: 'parent content' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Deep hierarchy child', label: childLabel, content: 'child content' }
    });
    await openEditor(page);

    await page.getByRole('button', { name: /Search/ }).click();
    await page.getByPlaceholder('Search blocks or create new...').fill(childLabel);
    await page.getByPlaceholder('Search blocks or create new...').press('Enter');

    const childTab = page.getByRole('tab').filter({ hasText: 'Deep hierarchy child' });
    const parentTab = page.getByRole('tab').filter({ hasText: 'Nearest existing parent' });
    await page.getByRole('button', { name: `Go to nearest parent block ${parentLabel}` }).click();
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');

    const tabLabels = await page.getByRole('tab').allTextContents();
    expect(tabLabels.indexOf(await parentTab.textContent() || '')).toBe(tabLabels.indexOf(await childTab.textContent() || '') + 1);

    await childTab.click();
    await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');

    await childTab.click();
    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Keyboard Shortcuts' }).click();
    await page.getByLabel('Go to nearest parent block shortcut').fill('mod+shift+p');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await page.keyboard.press('ControlOrMeta+Shift+P');
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /Go to nearest parent block/ })).toHaveCount(0);
});

test('restores root focus when switching and closing tabs', async ({ page }) => {
    const suffix = Date.now();
    const firstLabel = `test:tab-focus-a-${suffix}`;
    const secondLabel = `test:tab-focus-b-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Tab focus A', label: firstLabel, content: 'first tab content' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Tab focus B', label: secondLabel, content: 'second tab content' }
    });
    await openEditor(page);

    const openThroughSearch = async (label: string) => {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
        await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    };
    await openThroughSearch(firstLabel);
    await openThroughSearch(secondLabel);

    const firstTab = page.locator('[draggable="true"]').filter({ hasText: 'Tab focus A' });
    await firstTab.click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(firstLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();

    await firstTab.locator('button').click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]')).toContainText(secondLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
});

test('preserves recursive cursor and scroll state while switching mounted tabs', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:tab-restore-child-${suffix}`;
    const parentLabel = `test:tab-restore-parent-${suffix}`;
    const otherLabel = `test:tab-restore-other-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Restore child', label: childLabel, content: 'abcdef' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Restore parent',
            label: parentLabel,
            content: `${Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')}\n[[${childLabel}∨]]`
        }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Restore other', label: otherLabel, content: 'other tab' }
    });

    await openEditor(page);
    const openByLabel = async (label: string) => {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    };
    await openByLabel(parentLabel);
    const parentTab = page.getByRole('tab').filter({ hasText: 'Restore parent' });
    const parentPanelId = await parentTab.getAttribute('aria-controls');
    expect(parentPanelId).toBeTruthy();
    const parentPanel = page.locator(`#${parentPanelId}`);
    const parentScroller = parentPanel;
    await parentScroller.evaluate(element => { element.scrollTop = 420; });

    const parentEditor = parentPanel.locator('.cm-content').first();
    await parentEditor.focus();
    await page.keyboard.press('ControlOrMeta+End');
    await parentScroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const childHost = parentPanel.locator('[data-testid^="embedded-editor-host-"]').first();
    await expect(childHost).toBeVisible();
    await childHost.locator('.cm-line').filter({ hasText: 'abcdef' }).click();
    const childEditor = parentPanel.locator('.cm-content').nth(1);
    await childEditor.focus();
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const retainedScrollTop = await parentScroller.evaluate(element => element.scrollTop);

    await openByLabel(otherLabel);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').filter({ visible: true }).first()).toBeFocused();

    await parentTab.click();
    await expect(childEditor).toBeFocused();
    await page.keyboard.insertText('X');
    await expect(childEditor).toContainText('abcXdef');
    expect(await parentScroller.evaluate(element => element.scrollTop)).toBe(retainedScrollTop);
});

test('supports accessible keyboard navigation and closing in the tab strip', async ({ page }) => {
    const suffix = Date.now();
    const firstLabel = `test:tab-keyboard-first-${suffix}`;
    const secondLabel = `test:tab-keyboard-second-${suffix}`;
    await page.request.post('/api/blocks', { data: { title: 'Keyboard tab first', label: firstLabel, content: 'first' } });
    await page.request.post('/api/blocks', { data: { title: 'Keyboard tab second', label: secondLabel, content: 'second' } });
    await openEditor(page);
    for (const label of [firstLabel, secondLabel]) {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    }

    const firstTab = page.getByRole('tab').filter({ hasText: 'Keyboard tab first' });
    const secondTab = page.getByRole('tab').filter({ hasText: 'Keyboard tab second' });
    // Wait for the editor autofocus scheduled by opening the second block;
    // otherwise it can race and steal focus back from the tab on slower VMs.
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    await secondTab.press('ArrowLeft');
    await expect(firstTab).toBeFocused();
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await firstTab.press('Enter');
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await firstTab.press('Delete');
    await expect(firstTab).toHaveCount(0);
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
});

test('handles desktop close, reopen, next, and previous note commands', async ({ page }) => {
    await page.addInitScript(() => {
        let commandListener: ((command: 'close-tab' | 'reopen-tab' | 'next-tab' | 'previous-tab') => void) | null = null;
        window.mathNotesDesktop = {
            updateShortcuts() {},
            chooseWorkspace: async () => false,
            getWorkspacePath: async () => '/tmp/math-notes-test-workspace',
            showWorkspaceInFolder: async () => true,
            onCommand(callback) {
                commandListener = callback;
                return () => { commandListener = null; };
            },
            onPrepareWorkspaceChange() { return () => {}; }
        };
        (window as any).__sendMathNotesCommand = (command: 'close-tab' | 'reopen-tab' | 'next-tab' | 'previous-tab') => commandListener?.(command);
    });

    const suffix = Date.now();
    const firstLabel = `test:desktop-tab-first-${suffix}`;
    const secondLabel = `test:desktop-tab-second-${suffix}`;
    await page.request.post('/api/blocks', { data: { title: 'Desktop tab first', label: firstLabel, content: 'first' } });
    await page.request.post('/api/blocks', { data: { title: 'Desktop tab second', label: secondLabel, content: 'second' } });
    await openEditor(page);
    for (const label of [firstLabel, secondLabel]) {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    }

    const firstTab = page.getByRole('tab').filter({ hasText: 'Desktop tab first' });
    const secondTab = page.getByRole('tab').filter({ hasText: 'Desktop tab second' });
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => (window as any).__sendMathNotesCommand('previous-tab'));
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => (window as any).__sendMathNotesCommand('next-tab'));
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => (window as any).__sendMathNotesCommand('close-tab'));
    await expect(secondTab).toHaveCount(0);
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => (window as any).__sendMathNotesCommand('reopen-tab'));
    await expect(secondTab).toHaveCount(1);
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
});

test('does not create a block when Down is pressed at the final root row', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'final root row');
    const before = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const after = await (await page.request.get('/api/blocks?metaOnly=true')).json();
    expect(after).toHaveLength(before.length);
    await expect(editor).toBeFocused();
});

test('keeps touching embeds rendered and enters their raw syntax with horizontal arrows', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:keyboard-touch-target-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Keyboard touch target', label: targetLabel, content: 'Nested content' }
    });
    const editor = await openEditor(page);

    for (const syntax of [
        `[[${targetLabel}]]`,
        `[[${targetLabel}∨]]`,
        `[[@${targetLabel}]]`,
        `[[@${targetLabel}∨]]`
    ]) {
        await replaceEditorText(page, editor, syntax);

        await page.keyboard.press('ControlOrMeta+Home');
        const selectedEmbed = page.locator('[data-embed-keyboard-selected="true"]');
        await expect(selectedEmbed).toHaveCount(1);
        await expect(selectedEmbed).toHaveCSS('outline-style', 'dotted');
        await expect(selectedEmbed).toHaveCSS('outline-width', '1px');
        await expect(selectedEmbed).toHaveCSS('outline-color', 'rgba(96, 165, 250, 0.92)');
        await expect(selectedEmbed).toHaveCSS('border-radius', '0px');
        await expect(page.getByText('Keyboard touch target', { exact: true }).filter({ visible: true }).first()).toBeVisible();

        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
        await expect(editor).toContainText(syntax);

        await page.keyboard.press('End');
        await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
        await expect(page.getByText('Keyboard touch target', { exact: true }).filter({ visible: true }).first()).toBeVisible();

        await page.keyboard.press('ArrowLeft');
        await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
        await expect(editor).toContainText(syntax);
    }

    const surroundedStandout = `prefix [[@${targetLabel}]] suffix`;
    await replaceEditorText(page, editor, surroundedStandout);
    await page.keyboard.press('ControlOrMeta+Home');
    for (let index = 0; index < 'prefix '.length; index++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect(editor).toContainText(surroundedStandout);

    await replaceEditorText(page, editor, surroundedStandout);
    await page.keyboard.press('ControlOrMeta+End');
    for (let index = 0; index < ' suffix'.length; index++) await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect(editor).toContainText(surroundedStandout);
});

test('routes nested editor boundary arrows before default cursor movement', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:navigation-child-${suffix}`;
    const sourceLabel = `test:navigation-parent-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation child', label: targetLabel, content: 'Only child line' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation parent', label: sourceLabel, content: `[[${targetLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    const childEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);

    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('keeps the editable parent ancestry while navigating out of a nested child', async ({ page }) => {
    const suffix = Date.now();
    const leafLabel = `test:navigation-hot-leaf-${suffix}`;
    const middleLabel = `test:navigation-hot-middle-${suffix}`;
    const rootLabel = `test:navigation-hot-root-${suffix}`;
    const leaf = await (await page.request.post('/api/blocks', {
        data: { title: 'Hot ancestry leaf', label: leafLabel, content: 'leaf first\nleaf final' }
    })).json();
    const middle = await (await page.request.post('/api/blocks', {
        data: { title: 'Hot ancestry middle', label: middleLabel, content: `middle before\n[[${leafLabel}∨]]\nmiddle after` }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Hot ancestry root', label: rootLabel, content: `root before\n[[${middleLabel}∨]]\nroot after` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    const middleHost = page.getByTestId(`embedded-editor-host-${middle.id}`);
    const leafHost = page.getByTestId(`embedded-editor-host-${leaf.id}`);
    const directContent = (host: typeof middleHost) => host
        .locator('[data-editor-dormant]').first()
        .locator(':scope > .cm-editor > .cm-scroller > .cm-content');
    const middleEditor = directContent(middleHost);
    const leafEditor = directContent(leafHost);

    await rootEditor.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(middleEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(leafEditor).toBeFocused();
    await expect(middleHost).toHaveAttribute('data-editor-activated', 'true');
    await expect(leafHost).toHaveAttribute('data-editor-activated', 'true');

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowUp');
    await expect(middleEditor).toBeFocused();
    await expect(leafEditor).not.toBeFocused();
    await expect(middleHost).toHaveAttribute('data-editor-activated', 'true');
    await expect(leafHost).toHaveAttribute('data-editor-activated', 'false');
    await expect(middleHost.locator('[data-embed-keyboard-selected="true"]')).toContainText('Hot ancestry leaf');

    await page.keyboard.press('ArrowDown');
    await expect(leafEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(middleEditor).toBeFocused();
    await page.keyboard.insertText('RETURN-');
    await expect(middleEditor).toContainText('RETURN-');
});

test('keeps keyboard focus on the exact repeated embedded occurrence', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:occurrence-focus-child-${suffix}`;
    const parentLabel = `test:occurrence-focus-parent-${suffix}`;
    const rootLabel = `test:occurrence-focus-root-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Repeated occurrence child', label: childLabel, content: 'exact child cursor' }
    })).json();
    const parent = await (await page.request.post('/api/blocks', {
        data: { title: 'Repeated occurrence parent', label: parentLabel, content: `parent row\n[[${childLabel}∨]]` }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Repeated occurrence root', label: rootLabel, content: `[[${parentLabel}∨]]\nseparator\n[[${parentLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');

    const parentHosts = page.getByTestId(`embedded-editor-host-${parent.id}`);
    const childHosts = page.getByTestId(`embedded-editor-host-${child.id}`);
    await expect(parentHosts).toHaveCount(2);
    await expect(childHosts).toHaveCount(2);
    const secondParentEditor = parentHosts.nth(1)
        .locator('[data-editor-dormant]').first()
        .locator(':scope > .cm-editor > .cm-scroller > .cm-content');
    const secondChildEditor = childHosts.nth(1)
        .locator('[data-editor-dormant]').first()
        .locator(':scope > .cm-editor > .cm-scroller > .cm-content');

    await secondChildEditor.locator('.cm-line').click({ position: { x: 55, y: 8 } });
    await expect(secondChildEditor).toBeFocused();
    await expect(childHosts.nth(0).locator('.cm-content:focus')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowUp');
    await expect(secondParentEditor).toBeFocused();
    await expect(parentHosts.nth(0).locator('.cm-content:focus')).toHaveCount(0);
    await expect(parentHosts.nth(1).locator('[data-embed-keyboard-selected="true"]')).toContainText('Repeated occurrence child');
});

test('exits through nested final embeds to the parent editor boundary', async ({ page }) => {
    const suffix = Date.now();
    const innerLabel = `test:navigation-inner-${suffix}`;
    const outerLabel = `test:navigation-outer-${suffix}`;
    const rootLabel = `test:navigation-root-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Nested navigation inner', label: innerLabel, content: 'Inner final row' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Nested navigation outer', label: outerLabel, content: `[[${innerLabel}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Nested navigation root',
            label: rootLabel,
            content: `before\n[[${outerLabel}∨]]\nafter\nfinal`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();

    const outerEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    const innerEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(2);

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(outerEditor).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(innerEditor).toBeFocused();

    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(innerEditor).not.toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('enters the deepest final open embed from below and exits through the same visual path', async ({ page }) => {
    const suffix = Date.now();
    const level3Label = `test:navigation-up-level-3-${suffix}`;
    const level2Label = `test:navigation-up-level-2-${suffix}`;
    const level1Label = `test:navigation-up-level-1-${suffix}`;
    const rootLabel = `test:navigation-up-root-${suffix}`;

    const level3 = await (await page.request.post('/api/blocks', {
        data: { title: 'Navigation level 3', label: level3Label, content: 'deep first\ndeep final' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation level 2', label: level2Label, content: `level two\n[[${level3Label}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Navigation level 1', label: level1Label, content: `level one\n[[${level2Label}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Navigation upward root',
            label: rootLabel,
            content: `[[${level1Label}∨]]\nbelow`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    const deepestHost = page.getByTestId(`embedded-editor-host-${level3.id}`);
    await expect(deepestHost.locator('.cm-content').first()).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.getByText('below', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    await expect(deepestHost.locator('.cm-content:focus')).toHaveCount(1);

    // Down from that deepest final row follows the inverse route and reaches
    // the root row below all three embeds without stopping on any title.
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(rootEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('moves one rendered row at a time around a closed standout title', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:closed-standout-target-${suffix}`;
    const sourceLabel = `test:closed-standout-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Closed standout target', label: targetLabel, content: 'Closed child content' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Closed standout source',
            label: sourceLabel,
            content: `above\n[[@${targetLabel}]]\nbelow`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();
    await expect(parentEditor).toBeFocused();

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await page.keyboard.insertText('DOWN-');
    await expect(parentEditor.locator('.cm-line').nth(2)).toContainText('DOWN-');

    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await page.keyboard.insertText('UP-');
    await expect(parentEditor.locator('.cm-line').first()).toContainText('UP-');
});

test('visits suffix and prefix rows surrounding a closed standout title', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:surrounded-standout-target-${suffix}`;
    const sourceLabel = `test:surrounded-standout-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Surrounded standout target', label: targetLabel, content: 'Child content' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Surrounded standout source',
            label: sourceLabel,
            content: `prefix [[@${targetLabel}]] suffix\nnextline`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();

    await expect(parentEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await page.keyboard.insertText('SUFFIX-');
    await expect(parentEditor.locator('.cm-line').first()).toContainText('SUFFIX-');
    await expect(parentEditor.locator('.cm-line').nth(1)).not.toContainText('SUFFIX-');

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('follows rendered rows through prefix text, inline bodies, and standout titles', async ({ page }) => {
    const suffix = Date.now();
    const inlineTargetLabel = `test:visual-inline-target-${suffix}`;
    const standoutTargetLabel = `test:visual-standout-target-${suffix}`;
    const inlineSourceLabel = `test:visual-inline-source-${suffix}`;
    const standoutSourceLabel = `test:visual-standout-source-${suffix}`;
    const wrappedChild = Array.from({ length: 45 }, (_, index) => `wrapped-${index}`).join(' ');

    await page.request.post('/api/blocks', {
        data: { title: 'Visual inline target', label: inlineTargetLabel, content: wrappedChild }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Visual standout target', label: standoutTargetLabel, content: 'Standout child row' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Visual inline source',
            label: inlineSourceLabel,
            content: `above\nprefix [[${inlineTargetLabel}∨]] suffix\nafter`
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Visual standout source',
            label: standoutSourceLabel,
            content: `prefix [[@${standoutTargetLabel}∨]] suffix\nafter`
        }
    });

    await openEditor(page);
    const openByLabel = async (label: string) => {
        await page.getByRole('button', { name: /Search/ }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
        await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first()).toBeFocused();
    };

    await openByLabel(inlineSourceLabel);
    let parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    let childEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    await page.keyboard.press('ControlOrMeta+Home');

    // The next source line starts with ordinary text, so the first Down stays
    // in the parent instead of jumping over that text into the open child.
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    // Nearby child views now remain mounted in dormant mode so the following
    // navigation step does not replace their layout.
    await expect(childEditor).toHaveCount(1);
    await expect(childEditor).not.toBeFocused();

    // The inline title shares that visual row; its body is the next row.
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();

    // A soft-wrapped first source line still has more visual rows, so Down must
    // remain inside the child rather than treating it as the child boundary.
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();

    // Up from the first child row returns to the visible title row. Entering
    // again and leaving the final row proceeds into the visible parent suffix.
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowUp');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);

    await openByLabel(standoutSourceLabel);
    parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    childEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').nth(1);
    await page.keyboard.press('ControlOrMeta+Home');

    // A standout title creates its own rendered row and is therefore visited
    // before entering the child body.
    await page.keyboard.press('ArrowDown');
    await expect(parentEditor).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(childEditor).toBeFocused();
});

test('keeps the boundary caret to one text row beside an open inline embed', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:caret-inline-child-${suffix}`;
    const sourceLabel = `test:caret-inline-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Inline caret child',
            label: childLabel,
            content: Array.from({ length: 18 }, (_, index) => `child row ${index}`).join('\n')
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Inline caret source',
            label: sourceLabel,
            content: `above\nprefix [[${childLabel}∨]] suffix\nbelow`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const content = parentEditor.locator(':scope > .cm-scroller > .cm-content');
    await content.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');

    const caretHeight = await parentEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor').first()
        .evaluate(element => element.getBoundingClientRect().height);
    const lineHeight = await parentEditor.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize) * 1.6);
    expect(caretHeight).toBeLessThanOrEqual(lineHeight + 2);
});

test('uses a normal title-edge caret without drawing a block-height caret', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:object-caret-child-${suffix}`;
    const sourceLabel = `test:object-caret-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Object caret child',
            label: childLabel,
            content: Array.from({ length: 24 }, (_, index) => `child row ${index}`).join('\n')
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Object caret source', label: sourceLabel, content: `above\n[[@${childLabel}∨]]\nafter` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const parentContent = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await parentContent.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');

    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toContainText('Object caret child');
    await expect(parentEditor).toHaveClass(/cm-embedded-object-selected/);
    await expect(parentEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor').first()).toBeHidden();
    const titleCaret = page.locator('[data-embed-keyboard-selected="true"] [data-testid="embedded-title-caret"]');
    await expect(titleCaret).toBeVisible();
    await expect(titleCaret).toHaveCSS('animation-name', 'embedded-title-caret-blink');
    await expect(titleCaret).toHaveCSS('animation-duration', '1.2s');
    const titleCaretHeight = await titleCaret.evaluate(element => element.getBoundingClientRect().height);
    const titleLineHeight = await page.locator('[data-embed-keyboard-selected="true"]').evaluate(element =>
        Number.parseFloat(getComputedStyle(element).fontSize) * 1.3
    );
    expect(titleCaretHeight).toBeGreaterThan(8);
    expect(titleCaretHeight).toBeLessThanOrEqual(titleLineHeight + 2);
});

test('places the after-title caret beside the final math fragment when an inline title wraps', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:wrapped-title-caret-target-${suffix}`;
    const sourceLabel = `test:wrapped-title-caret-source-${suffix}`;
    const alias = 'measurable in $\\R^n$';
    const source = `prefix [[${targetLabel}||${alias}]]`;
    await page.request.post('/api/blocks', {
        data: { title: 'Measurable set', label: targetLabel, content: 'definition' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Wrapped title caret source', label: sourceLabel, content: source }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await editor.evaluate(element => { element.style.width = '135px'; });
    const content = editor.locator(':scope > .cm-scroller > .cm-content');
    await content.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        const view = EditorView.findFromDOM(element.closest('.cm-editor')!);
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.focus();
    });

    const title = editor.locator('[data-embed-keyboard-selected="true"]');
    const caret = title.getByTestId('embedded-title-caret');
    await expect(caret).toHaveAttribute('data-edge', 'after');
    const geometry = await title.evaluate(element => {
        const text = element.querySelector(':scope > span')!;
        const math = element.querySelector('.cm-math-inline')!;
        const caret = element.querySelector('[data-testid="embedded-title-caret"]')!;
        return {
            fragments: text.getClientRects().length,
            math: math.getBoundingClientRect().toJSON(),
            caret: caret.getBoundingClientRect().toJSON()
        };
    });
    expect(geometry.fragments).toBeGreaterThan(1);
    expect(geometry.caret.left).toBeGreaterThanOrEqual(geometry.math.right - 4);
    expect(geometry.caret.top).toBeLessThan(geometry.math.bottom);
    expect(geometry.caret.bottom).toBeGreaterThan(geometry.math.top);

    await page.keyboard.press('Alt+ArrowLeft');
    await expect(caret).toHaveAttribute('data-edge', 'before');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(caret).toHaveAttribute('data-edge', 'after');

    await editor.evaluate(element => { element.style.width = '500px'; });
    const unwrapped = await title.evaluate(element => ({
        fragments: element.querySelector(':scope > span')!.getClientRects().length,
        mathRight: element.querySelector('.cm-math-inline')!.getBoundingClientRect().right,
        caretLeft: element.querySelector('[data-testid="embedded-title-caret"]')!.getBoundingClientRect().left
    }));
    expect(unwrapped.fragments).toBe(1);
    expect(unwrapped.caretLeft).toBeGreaterThanOrEqual(unwrapped.mathRight - 4);

    await page.keyboard.insertText(' suffix');
    await expect(content).toContainText('suffix');
    const markdown = await content.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        return EditorView.findFromDOM(element.closest('.cm-editor')!).state.doc.toString();
    });
    expect(markdown).toBe(`${source} suffix`);
});

test('moves up from an inline title into the preceding wrap of its Markdown line', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:up-wrap-target-${suffix}`;
    const sourceLabel = `test:up-wrap-source-${suffix}`;
    const source = `first source line\n${'ordinary text '.repeat(12)}[[${targetLabel}||measurable in $\\R^n$]]`;
    await page.request.post('/api/blocks', {
        data: { title: 'Measurable set', label: targetLabel, content: 'definition' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Up wrap source', label: sourceLabel, content: source }
    });
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await editor.evaluate(element => { element.style.width = '360px'; });
    const content = editor.locator(':scope > .cm-scroller > .cm-content');
    await content.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        const view = EditorView.findFromDOM(element.closest('.cm-editor')!);
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('[[') } });
        view.focus();
    });
    const title = editor.locator('[data-embed-keyboard-selected="true"]');
    await expect(title).toBeVisible();
    const titleTop = await title.evaluate(element => element.getBoundingClientRect().top);
    await page.keyboard.press('ArrowUp');
    await expect(title).toHaveCount(0);
    const result = await content.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        const view = EditorView.findFromDOM(element.closest('.cm-editor')!);
        return { head: view.state.selection.main.head,
            top: view.coordsAtPos(view.state.selection.main.head, 1)?.top ?? 0,
            line: view.state.doc.lineAt(view.state.selection.main.head).number };
    });
    expect(result.line).toBe(2);
    expect(result.top).toBeLessThan(titleTop - 2);
    await page.keyboard.press('ArrowDown');
    await expect(title).toBeVisible();
});

test('moves by word across a selected embedded title without moving the viewport', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:option-title-child-${suffix}`;
    const sourceLabel = `test:option-title-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'proof',
            label: childLabel,
            content: Array.from({ length: 20 }, (_, index) => `proof row ${index}`).join('\n')
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Option title source',
            label: sourceLabel,
            content: `${Array.from({ length: 30 }, (_, index) => `leading row ${index}`).join('\n')}\nrow before proof\n[[@${childLabel}∨]]\nrow after proof`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    await page.getByText('row before proof', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const selectedTitle = page.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('Proof');
    await expect(selectedTitle.getByTestId('embedded-title-caret')).toHaveCSS('right', '-3px');
    const scrollTop = await panel.evaluate(element => element.scrollTop);

    await page.keyboard.press('Alt+ArrowLeft');
    await expect(selectedTitle.getByTestId('embedded-title-caret')).toHaveCSS('left', '-3px');
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(scrollTop);

    await page.keyboard.press('Alt+ArrowRight');
    await expect(selectedTitle.getByTestId('embedded-title-caret')).toHaveCSS('right', '-3px');
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(scrollTop);
});

test('shows an embedded load error and retries without leaving a permanent skeleton', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:load-retry-child-${suffix}`;
    const sourceLabel = `test:load-retry-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Retry child', label: childLabel, content: 'Loaded after retry.' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Retry source', label: sourceLabel, content: `[[${childLabel}∨]]` }
    });
    let attempts = 0;
    await page.route(`**/api/blocks/${child.id}`, async route => {
        attempts += 1;
        if (attempts === 1) {
            await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Temporary test failure' });
        } else {
            await route.continue();
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const error = page.getByTestId(`embedded-load-error-${child.id}`);
    await expect(error).toContainText('Could not load this embedded note.');
    await expect(error).toContainText('503');
    await expect(page.getByText(/Changes may not have been saved:/)).toHaveCount(0);
    await error.getByRole('button', { name: 'Retry loading' }).click();
    await expect(error).toHaveCount(0);
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`)).toContainText('Loaded after retry.');
    await expect(page.getByText(/Changes may not have been saved:/)).toHaveCount(0);
});

test('shows one editable broken chip for an open missing embed', async ({ page }) => {
    const suffix = Date.now();
    const missingLabel = `test:missing-open-${suffix}`;
    const sourceLabel = `test:missing-open-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Missing open source', label: sourceLabel, content: `Before [[${missingLabel}∨]] after` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const chip = page.getByText(`[[${missingLabel}∨]]`, { exact: true });
    await expect(chip).toHaveCount(1);
    await chip.click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-embedded-editing')).toBeVisible();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content:focus').first()).toBeVisible();
});

test('resolves an open missing embed when its target is created without crashing', async ({ page }) => {
    const suffix = Date.now();
    const missingLabel = `test:late-embed-${suffix}`;
    const sourceLabel = `test:late-source-${suffix}`;
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.request.post('/api/blocks', {
        data: { title: 'Late embed source', label: sourceLabel, content: `Before [[${missingLabel}∨]] after` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const sourceTab = page.getByRole('tab', { name: 'Late embed source' });
    await expect(page.getByText(`[[${missingLabel}∨]]`, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /Search/ }).click();
    await search.fill(missingLabel);
    await search.press('Enter');
    await page.getByRole('dialog', { name: 'Create new block?' })
        .getByRole('button', { name: 'Create block' }).click();
    await sourceTab.click();

    await expect(page.getByText(`[[${missingLabel}∨]]`, { exact: true })).toHaveCount(0);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]')
        .filter({ hasText: missingLabel })).toBeVisible();
    expect(pageErrors).toEqual([]);
});

test('shows a retryable error when a top-level note fails to load', async ({ page }) => {
    const label = `test:root-load-retry-${Date.now()}`;
    const block = await (await page.request.post('/api/blocks', {
        data: { title: 'Root load retry', label, content: 'Restored root content.' }
    })).json();
    let allowRetry = false;
    await page.route(`**/api/blocks/${block.id}`, route => {
        return allowRetry
            ? route.continue()
            : route.fulfill({ status: 503, body: 'Temporary test failure' });
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(label);
    await search.press('Enter');

    const error = page.getByTestId(`block-load-error-${block.id}`);
    await expect(error).toContainText('Could not load this note.');
    allowRetry = true;
    await error.getByRole('button', { name: 'Retry loading' }).click();
    await expect(error).toHaveCount(0);
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"]')).toContainText('Restored root content.');
});

test('shows a retryable error when a backlink excerpt fails to load', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:backlink-retry-target-${suffix}`;
    const target = await (await page.request.post('/api/blocks', {
        data: { title: 'Backlink retry target', label: targetLabel, content: 'Target content.' }
    })).json();
    const source = await (await page.request.post('/api/blocks', {
        data: { title: 'Backlink retry source', label: `test:backlink-retry-source-${suffix}`, content: `See [[${targetLabel}]].` }
    })).json();
    let allowRetry = false;
    await page.route(`**/api/blocks/${source.id}`, route => {
        return allowRetry
            ? route.continue()
            : route.fulfill({ status: 503, body: 'Temporary test failure' });
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(target.label);
    await search.press('Enter');
    await page.getByTestId('backlinks-button').click();

    const popover = page.getByTestId('backlinks-popover');
    await expect(popover).toContainText('Could not load excerpt:');
    allowRetry = true;
    await popover.getByRole('button', { name: 'Retry excerpt' }).click();
    await expect(popover).toContainText(`See [[${targetLabel}]].`);
    await expect(popover.getByRole('button', { name: 'Retry excerpt' })).toHaveCount(0);
});

test('moves up from the after-title caret to the immediately preceding visual row', async ({ page }) => {
    const suffix = Date.now();
    const unrelatedLabel = `test:title-up-unrelated-${suffix}`;
    const currentLabel = `test:title-up-current-${suffix}`;
    const sourceLabel = `test:title-up-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Earlier title that must not receive focus', label: unrelatedLabel, content: 'earlier body' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Current expanded title',
            label: currentLabel,
            content: Array.from({ length: 12 }, (_, index) => `expanded child row ${index}`).join('\n')
        }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Title Up source',
            label: sourceLabel,
            content: `[[${unrelatedLabel}]]\nordinary row immediately above\nusing [[${currentLabel}∨]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootContent = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await rootContent.focus();
    await page.keyboard.press('ControlOrMeta+End');

    const selectedTitle = page.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('Current expanded title');
    const titleCaret = selectedTitle.getByTestId('embedded-title-caret');
    await expect(titleCaret).toHaveAttribute('data-edge', 'after');

    await page.keyboard.press('ArrowUp');

    await expect(rootContent).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    const precedingRow = page.getByText('ordinary row immediately above', { exact: true });
    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const nativeCaret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    await expect(nativeCaret).toBeVisible();
    const rowRect = await precedingRow.evaluate(element => element.getBoundingClientRect().toJSON());
    const caretRect = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    const caretCenterY = caretRect.top + caretRect.height / 2;
    expect(caretCenterY).toBeGreaterThanOrEqual(rowRect.top - 2);
    expect(caretCenterY).toBeLessThanOrEqual(rowRect.bottom + 2);
    await expect(page.getByText('Earlier title that must not receive focus', { exact: true }))
        .not.toHaveAttribute('data-embed-keyboard-selected', 'true');
});

test('does not skip an inline-math text row above an expanded inline title', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:math-rich-title-child-${stamp}`;
    const sourceLabel = `test:math-rich-title-source-${stamp}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Riemann-Lebesgue lemma', label: childLabel, content: 'For $f\\in L^1$\nproof row' }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Math-rich title source',
            label: sourceLabel,
            content: [
                '\\[',
                '\\begin{align*}',
                'f(x)-\\tilde f(x) &= f(x)\\cdot\\left(\\lim_{m\\to\\infty}\\frac{1}{2\\pi}\\int_{-\\pi}^{\\pi}D_m(y)dy\\right)\\\\',
                '&=\\lim_{m\\to\\infty}\\frac{1}{2\\pi}\\int_{-\\pi}^{\\pi}(f(x)-f(y))D_m(x-y)dy\\\\',
                '&=\\lim_{m\\to\\infty}\\frac{1}{2\\pi}\\int_{-\\pi}^{\\pi}\\frac{f(x)-f(y)}{\\sin((x-y)/2)}\\sin((m+1/2)(x-y))dy.',
                '\\end{align*}',
                '\\]',
                'And if $f$ is $C^1$, we get the function $g_x(y):=\\frac{f(x)-f(y)}{\\sin(\\frac{x-y}{2})}$ is $C^0$ for all $x$.',
                `using [[${childLabel}∨]], we get `
            ].join('\n')
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-editor')).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const rootContent = rootEditor.locator(':scope > .cm-scroller > .cm-content');
    const precedingRow = rootContent.locator(':scope > .cm-line').filter({ hasText: 'And if' });
    const nativeCaret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    await page.getByText(', we get', { exact: true }).click({ position: { x: 1, y: 8 } });
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toContainText('Riemann-Lebesgue lemma');

    await page.keyboard.press('ArrowUp');
    await expect(rootContent).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect(nativeCaret).toBeVisible();
    const rowRect = await precedingRow.evaluate(element => element.getBoundingClientRect().toJSON());
    const caretRect = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(caretRect.top + caretRect.height / 2).toBeGreaterThanOrEqual(rowRect.top - 2);
    expect(caretRect.top + caretRect.height / 2).toBeLessThanOrEqual(rowRect.bottom + 2);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toContainText('Riemann-Lebesgue lemma');
});

test('does not skip an inline-math text row below a closed inline title', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:math-rich-down-child-${stamp}`;
    const sourceLabel = `test:math-rich-down-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Closed lemma', label: childLabel, content: 'lemma body' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Math-rich Down source',
            label: sourceLabel,
            content: [
                `using [[${childLabel}]]`,
                'And if $f$ is $C^1$, then $g_x(y):=\\frac{f(x)-f(y)}{\\sin(x-y)}$ is $C^0$ for all $x$.',
                '\\[',
                '\\int_{-\\pi}^{\\pi} f(y)\\sin(my)\\,dy=0',
                '\\]'
            ].join('\n')
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const rootContent = rootEditor.locator(':scope > .cm-scroller > .cm-content');
    const nextRow = rootContent.locator(':scope > .cm-line').filter({ hasText: 'And if' });
    const nativeCaret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    await rootContent.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toContainText('Closed lemma');

    await page.keyboard.press('ArrowDown');
    await expect(rootContent).toBeFocused();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect(nativeCaret).toBeVisible();
    const rowRect = await nextRow.evaluate(element => element.getBoundingClientRect().toJSON());
    const caretRect = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(caretRect.top + caretRect.height / 2).toBeGreaterThanOrEqual(rowRect.top - 2);
    expect(caretRect.top + caretRect.height / 2).toBeLessThanOrEqual(rowRect.bottom + 2);
});

test('moves down from a standalone title through a blank and short row before block math', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:title-down-short-target-${suffix}`;
    const sourceLabel = `test:title-down-short-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'A deliberately wide embedded title for navigation', label: targetLabel, content: 'closed child' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Title Down short-row source',
            label: sourceLabel,
            content: `a preceding row
[[${targetLabel}]]

short next row
\\[
\\sum_{n=1}^{\\infty} a_n
\\]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const rootEditor = panel.locator('.cm-editor').first();
    const rootContent = rootEditor.locator(':scope > .cm-scroller > .cm-content');
    await rootContent.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    const selectedTitle = panel.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('A deliberately wide embedded title');

    const scrollTopBefore = await panel.evaluate(element => element.scrollTop);
    await page.keyboard.press('ArrowDown');
    await expect(rootContent).toBeFocused();
    await expect(selectedTitle).toHaveCount(0);
    const blankLine = rootContent.locator(':scope > .cm-line').nth(2);
    const cursor = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    const [blankRect, blankCursorRect] = await Promise.all([
        blankLine.evaluate(element => element.getBoundingClientRect().toJSON()),
        cursor.evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(blankCursorRect.top).toBeLessThan(blankRect.bottom);
    expect(blankCursorRect.bottom).toBeGreaterThan(blankRect.top);
    const scrollTopAfterBlank = await panel.evaluate(element => element.scrollTop);
    expect(Math.abs(scrollTopAfterBlank - scrollTopBefore)).toBeLessThanOrEqual(1);

    await page.keyboard.press('ArrowDown');
    const shortRow = page.getByText('short next row', { exact: true });
    await expect.poll(async () => {
        const [shortRect, shortCursorRect] = await Promise.all([
            shortRow.evaluate(element => element.getBoundingClientRect().toJSON()),
            cursor.evaluate(element => element.getBoundingClientRect().toJSON())
        ]);
        return shortCursorRect.top < shortRect.bottom + 2
            && shortCursorRect.bottom > shortRect.top - 2;
    }).toBe(true);
    await expect(rootEditor.locator('.cm-math-editing')).toHaveCount(0);
});

test('keeps first and following short rows when crossing an open embedded editor', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:open-boundary-short-child-${suffix}`;
    const sourceLabel = `test:open-boundary-short-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Open child with short edges',
            label: childLabel,
            content: `child short row
\\[
\\int_{-\\pi}^{\\pi} f(x)\\,dx
\\]`
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Open boundary short-row source',
            label: sourceLabel,
            content: `above
[[@${childLabel}∨]]
parent short row
\\[
\\sum_{k=1}^{N} k
\\]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const rootContent = panel.locator('.cm-content').first();
    await rootContent.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await expect(panel.locator('[data-embed-keyboard-selected="true"]')).toContainText('Open child with short edges');
    await page.keyboard.press('ArrowDown');

    const childHost = page.getByTestId(`embedded-editor-host-${child.id}`);
    const childContent = childHost.locator('.cm-content:focus');
    await expect(childContent).toHaveCount(1);
    const childShortRow = childHost.getByText('child short row', { exact: true });
    const childCursor = childHost.locator('.cm-cursor-primary').first();
    const [childRowRect, childCursorRect] = await Promise.all([
        childShortRow.evaluate(element => element.getBoundingClientRect().toJSON()),
        childCursor.evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(childCursorRect.top).toBeLessThan(childRowRect.bottom);
    expect(childCursorRect.bottom).toBeGreaterThan(childRowRect.top);

    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowDown');
    await expect(rootContent).toBeFocused();
    const parentShortRow = page.getByText('parent short row', { exact: true });
    const rootCursor = panel.locator('.cm-editor').first()
        .locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    const [parentRowRect, parentCursorRect] = await Promise.all([
        parentShortRow.evaluate(element => element.getBoundingClientRect().toJSON()),
        rootCursor.evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(parentCursorRect.top).toBeLessThan(parentRowRect.bottom);
    expect(parentCursorRect.bottom).toBeGreaterThan(parentRowRect.top);
});

for (const font of [null, 'Arial', 'Times New Roman']) {
test(`moves between consecutive rendered titles without entering hidden source${font ? ` (${font})` : ''}`, async ({ page }) => {
    const suffix = Date.now();
    const firstLabel = `test:consecutive-title-first-${suffix}`;
    const secondLabel = `test:consecutive-title-second-${suffix}`;
    const sourceLabel = `test:consecutive-title-source-${suffix}`;
    await page.request.post('/api/blocks', {
        data: { title: 'A much wider first rendered embedded title', label: firstLabel, content: 'first child' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'second title', label: secondLabel, content: 'second child' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Consecutive title source',
            label: sourceLabel,
            content: `above
[[${firstLabel}]]
[[${secondLabel}]]
below`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    if (font) {
        await page.addStyleTag({ content: `:root { --font-sans: "${font}"; }` });
    }
    const rootContent = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await rootContent.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    let selectedTitle = page.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('A much wider first rendered embedded title');

    await page.keyboard.press('ArrowDown');
    selectedTitle = page.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('second title');
    await expect(rootContent).not.toContainText(`[[${secondLabel}]]`);

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-embed-keyboard-selected="true"]'))
        .toContainText('A much wider first rendered embedded title');
    await expect(rootContent).not.toContainText(`[[${firstLabel}]]`);
});
}

test('preserves blank rows and crosses preceding nested embed boundaries logically', async ({ page }) => {
    const suffix = Date.now();
    const leafLabel = `test:blank-boundary-leaf-${suffix}`;
    const middleLabel = `test:blank-boundary-middle-${suffix}`;
    const outerLabel = `test:blank-boundary-outer-${suffix}`;
    const followingLabel = `test:blank-boundary-following-${suffix}`;
    const sourceLabel = `test:blank-boundary-source-${suffix}`;
    const leaf = await (await page.request.post('/api/blocks', {
        data: { title: 'Blank boundary leaf', label: leafLabel, content: 'deep final row before blank' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Blank boundary middle', label: middleLabel, content: `[[${leafLabel}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Blank boundary outer', label: outerLabel, content: `[[${middleLabel}∨]]` }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Following application title', label: followingLabel, content: 'following body' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Blank boundary source',
            label: sourceLabel,
            content: `[[${outerLabel}∨]]\n\n[[@${followingLabel}∨]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const rootEditor = panel.locator('.cm-editor').first();
    const rootContent = rootEditor.locator(':scope > .cm-scroller > .cm-content');
    const deepestRow = page.getByText('deep final row before blank', { exact: true });
    const followingTitle = page.locator('[role="tabpanel"][aria-hidden="false"]').getByText('Following application title', { exact: true });
    await expect(deepestRow).toBeVisible();
    await expect(followingTitle).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ));

    const [deepestRect, followingRect] = await Promise.all([
        deepestRow.evaluate(element => element.getBoundingClientRect().toJSON()),
        followingTitle.evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    // One real empty source row remains visible, but terminal padding from
    // every nested body must not accumulate into a large artificial void.
    expect(followingRect.top - deepestRect.bottom).toBeLessThan(130);

    await rootContent.focus();
    await page.keyboard.press('ControlOrMeta+End');
    await expect(panel.locator('[data-embed-keyboard-selected="true"]')).toContainText('Following application title');

    await page.keyboard.press('ArrowUp');
    await expect(rootContent).toBeFocused();
    await expect(panel.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    const [blankRect, cursorRect] = await Promise.all([
        followingTitle.evaluate(element => {
            const titleLine = element.closest('.cm-line');
            const previousLine = titleLine?.previousElementSibling;
            if (!(previousLine instanceof HTMLElement) || !previousLine.classList.contains('cm-line')) {
                throw new Error('Could not find the blank source row before the following title');
            }
            return previousLine.getBoundingClientRect().toJSON();
        }),
        rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')
            .evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(cursorRect.top).toBeLessThan(blankRect.bottom);
    expect(cursorRect.bottom).toBeGreaterThan(blankRect.top);

    // The next Up resolves source structure, enters the preceding open block,
    // and keeps forwarding the end-focus request until the deepest child owns
    // the final rendered row. No fixed nesting-depth or pixel limit is used.
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId(`embedded-editor-host-${leaf.id}`).locator('.cm-content:focus')).toHaveCount(1);
});

test('selects an expanded title below the caret without scrolling its hidden source endpoint', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:title-down-stable-child-${suffix}`;
    const sourceLabel = `test:title-down-stable-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'proof',
            label: childLabel,
            content: Array.from({ length: 30 }, (_, index) => `proof child row ${index}`).join('\n')
        }
    })).json();
    const leadingRows = Array.from({ length: 28 }, (_, index) => `leading row ${index}`).join('\n');
    await page.request.post('/api/blocks', {
        data: {
            title: 'Stable Down source',
            label: sourceLabel,
            content: `${leadingRows}\nindependent of m.\n[[@${childLabel}∨]]\nafter proof`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const precedingRow = page.getByText('independent of m.', { exact: true });
    await precedingRow.click();
    await page.keyboard.press('End');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const scrollTopBefore = await panel.evaluate(element => element.scrollTop);
    expect(scrollTopBefore).toBeGreaterThan(0);

    await page.keyboard.press('ArrowDown');

    const selectedTitle = page.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('Proof');
    await panel.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ));
    const scrollTopAfterTitle = await panel.evaluate(element => element.scrollTop);
    expect(Math.abs(scrollTopAfterTitle - scrollTopBefore)).toBeLessThanOrEqual(1);

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-content:focus')).toHaveCount(1);
});

test('keeps an expanded title boundary tied to its Markdown position for navigation and typing', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:title-source-boundary-child-${suffix}`;
    const sourceLabel = `test:title-source-boundary-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Fourier series on unit disk (in polar coordinates)',
            label: childLabel,
            content: Array.from({ length: 20 }, (_, index) => `embedded Fourier row ${index}`).join('\n')
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Title source boundary',
            label: sourceLabel,
            content: `uniqueness is established at the end of this row.\n[[@${childLabel}∨]]\nnext parent row`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const parentEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const parentContent = parentEditor.locator(':scope > .cm-scroller > .cm-content');
    await page.getByText('uniqueness is established at the end of this row.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');

    const selectedTitle = page.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('Fourier series on unit disk');
    await expect(selectedTitle.getByTestId('embedded-title-caret')).toBeVisible();
    await expect(parentEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')).toBeHidden();

    // Word navigation chooses the true source edge after [[label]]. Typing
    // there must edit the parent Markdown at that boundary and must not remain
    // trapped in object selection. Since an open embed visually interrupts
    // its source line, the inserted suffix is rendered after the child body.
    await page.keyboard.insertText(' SOURCE-WORD');
    await expect(selectedTitle).toHaveCount(0);
    await expect(parentContent).toContainText('SOURCE-WORD');

    const childRect = await page.getByTestId(`embedded-editor-host-${child.id}`)
        .evaluate(element => element.getBoundingClientRect().toJSON());
    const insertedRect = await parentContent.locator('.cm-line').filter({ hasText: 'SOURCE-WORD' })
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(insertedRect.top).toBeGreaterThanOrEqual(childRect.bottom - 2);
});

test('renders an open inline embed between its prefix and suffix', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:inline-order-child-${suffix}`;
    const sourceLabel = `test:inline-order-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Inline order child',
            label: childLabel,
            content: 'embedded first row\nembedded final row'
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Inline order source',
            label: sourceLabel,
            content: `before-inline [[${childLabel}∨]] after-inline`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const title = page.getByText('Inline order child', { exact: true });
    const body = page.getByTestId(`embedded-editor-host-${child.id}`);
    await expect(body.locator('.cm-editor')).toBeVisible();

    const sourceLine = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first()
        .locator(':scope > .cm-scroller > .cm-content > .cm-line')
        .filter({ hasText: 'before-inline' });
    const prefixRect = await sourceLine.evaluate(element => {
        const findRect = (needle: string) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
                const value = node.nodeValue || '';
                const index = value.indexOf(needle);
                if (index < 0) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + needle.length);
                return range.getBoundingClientRect().toJSON();
            }
            throw new Error(`Could not find ${needle}`);
        };
        return findRect('before-inline');
    });
    const [titleRect, bodyRect, continuationRect] = await Promise.all([
        title.evaluate(element => element.getBoundingClientRect().toJSON()),
        body.evaluate(element => element.getBoundingClientRect().toJSON()),
        page.getByText('after-inline', { exact: true })
            .evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(Math.abs(prefixRect.top - titleRect.top)).toBeLessThan(8);
    expect(bodyRect.top).toBeGreaterThanOrEqual(titleRect.bottom - 2);
    expect(continuationRect.top).toBeGreaterThanOrEqual(bodyRect.bottom - 2);
});

test('keeps a closed inline embed between surrounding words after toggling', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:closed-inline-child-${stamp}`;
    const sourceLabel = `test:closed-inline-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Inline equation title', label: childLabel, content: '\\[\nx^2=1\n\\]' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Closed inline source', label: sourceLabel, content: `Therefore solve the [[${childLabel}∨]], then continue.` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const title = page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-title]')
        .filter({ hasText: 'Inline equation title' });
    await expect(title).toBeVisible();
    await title.click();
    await expect(page.locator('[role="tabpanel"][aria-hidden="false"] [data-embed-nav-body]')).toHaveCount(0);

    const geometry = await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first().evaluate(editor => {
        const line = editor.querySelector('.cm-line')!;
        const title = line.querySelector<HTMLElement>('[data-embed-nav-title]')!;
        const rangeOf = (text: string) => {
            const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
                const index = (node.nodeValue || '').indexOf(text);
                if (index < 0) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + text.length);
                return range.getBoundingClientRect().toJSON();
            }
            throw new Error(`Missing ${text}`);
        };
        return { prefix: rangeOf('Therefore solve the'), title: title.getBoundingClientRect().toJSON(), suffix: rangeOf('then continue.') };
    });
    expect(Math.abs(geometry.prefix.top - geometry.title.top)).toBeLessThan(8);
    expect(Math.abs(geometry.title.top - geometry.suffix.top)).toBeLessThan(8);
});

test('keeps adjacent open inline titles with their surrounding text', async ({ page }) => {
    const stamp = Date.now();
    const firstLabel = `test:adjacent-first-${stamp}`;
    const secondLabel = `test:adjacent-second-${stamp}`;
    const sourceLabel = `test:adjacent-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Laplace equation', label: firstLabel, content: '\\[\nx^2=1\n\\]' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Poisson equation', label: secondLabel, content: '\\[\ny^2=1\n\\]' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Adjacent source', label: sourceLabel, content: `[[${firstLabel}∨]] and [[${secondLabel}∨]]\nTherefore to solve the [[${firstLabel}]], it is equivalent to solve for each m, the ODE.` }
    });
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    await expect(page.getByText('Poisson equation', { exact: true })).toBeVisible();
    const geometry = await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first().evaluate(editor => {
        const content = editor.querySelector(':scope > .cm-scroller > .cm-content')!;
        const rectOf = (needle: string) => {
            const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
                const index = (node.nodeValue || '').indexOf(needle);
                if (index < 0) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + needle.length);
                return range.getBoundingClientRect().toJSON();
            }
            throw new Error(`Missing ${needle}`);
        };
        return {
            and: rectOf('and'), poisson: rectOf('Poisson equation'),
            prefix: rectOf('Therefore to solve the'), closed: (() => {
                const title = Array.from(content.querySelectorAll<HTMLElement>('[data-embed-nav-title]'))
                    .filter(element => element.textContent?.includes('Laplace equation')).at(-1)!;
                return title.getBoundingClientRect().toJSON();
            })(),
            suffix: rectOf('it is equivalent')
        };
    });
    expect(Math.abs(geometry.and.top - geometry.poisson.top)).toBeLessThan(8);
    expect(Math.abs(geometry.prefix.top - geometry.closed.top)).toBeLessThan(8);
    expect(Math.abs(geometry.closed.top - geometry.suffix.top)).toBeLessThan(8);

    await page.getByText('Poisson equation', { exact: true }).click();
    const collapsedGap = await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first().evaluate(editor => {
        const title = Array.from(editor.querySelectorAll<HTMLElement>('[data-embed-nav-title]'))
            .find(element => element.textContent?.trim() === 'Poisson equation')!;
        const line = title.closest('.cm-line')!;
        return line.nextElementSibling!.getBoundingClientRect().top - line.getBoundingClientRect().bottom;
    });
    expect(Math.abs(collapsedGap)).toBeLessThan(2);
});

test('does not reuse block widget DOM for inline titles through repeated toggles and edits', async ({ page }) => {
    const stamp = Date.now();
    const firstLabel = `test:reuse-first-${stamp}`;
    const secondLabel = `test:reuse-second-${stamp}`;
    const sourceLabel = `test:reuse-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'First inline title', label: firstLabel, content: 'first body line\nsecond body line' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Second inline title', label: secondLabel, content: 'another body line' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Reuse source', label: sourceLabel, content: `before [[${firstLabel}]] and [[${secondLabel}]] after` }
    });

    const editor = await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const root = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const first = root.locator('[data-embed-nav-title]').filter({ hasText: 'First inline title' });
    const second = root.locator('[data-embed-nav-title]').filter({ hasText: 'Second inline title' });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    const assertWidgetStructure = async () => {
        const structure = await root.evaluate(element => {
            const wrappers = Array.from(element.querySelectorAll<HTMLElement>('.cm-embedded-block-wrapper'));
            const firstLine = element.querySelector('.cm-line')!;
            const rectOf = (needle: string) => {
                const walker = document.createTreeWalker(firstLine, NodeFilter.SHOW_TEXT);
                let node: Node | null;
                while ((node = walker.nextNode())) {
                    const index = (node.nodeValue || '').indexOf(needle);
                    if (index < 0) continue;
                    const range = document.createRange();
                    range.setStart(node, index);
                    range.setEnd(node, index + needle.length);
                    return range.getBoundingClientRect().top;
                }
                return null;
            };
            return {
                wrongTags: wrappers.filter(wrapper =>
                    wrapper.tagName !== (wrapper.dataset.embedPart === 'body' ? 'DIV' : 'SPAN')
                ).length,
                prefixTop: rectOf('before'),
                firstTop: firstLine.querySelector<HTMLElement>('[data-embed-nav-title]')?.getBoundingClientRect().top ?? null,
                suffixTop: rectOf('after')
            };
        });
        expect(structure.wrongTags).toBe(0);
        if (structure.prefixTop !== null && structure.firstTop !== null) {
            expect(Math.abs(structure.prefixTop - structure.firstTop)).toBeLessThan(8);
        }
        if (structure.suffixTop !== null && structure.firstTop !== null) {
            expect(Math.abs(structure.suffixTop - structure.firstTop)).toBeLessThan(8);
        }
    };

    for (let index = 0; index < 3; index++) {
        await first.click();
        await expect(root.locator('[data-embed-nav-body]')).toHaveCount(1);
        await assertWidgetStructure();
        await second.click();
        await expect(root.locator('[data-embed-nav-body]')).toHaveCount(2);
        await assertWidgetStructure();
        await first.click();
        await expect(root.locator('[data-embed-nav-body]')).toHaveCount(1);
        await assertWidgetStructure();
        await second.click();
        await expect(root.locator('[data-embed-nav-body]')).toHaveCount(0);
        await assertWidgetStructure();
    }

    await editor.click({ position: { x: 3, y: 8 } });
    await page.keyboard.press('Home');
    await page.keyboard.type('added ');
    await expect(root.getByText('added before', { exact: false })).toBeVisible();
    await assertWidgetStructure();
});

test('moves horizontally through both caret locations at an open inline suffix', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:virtual-break-child-${stamp}`;
    const sourceLabel = `test:virtual-break-source-${stamp}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Virtual break child', label: childLabel, content: 'first child row\nlast child row' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Virtual break source', label: sourceLabel, content: `prefix [[${childLabel}∨]]suffix` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const suffix = page.getByText('suffix', { exact: true });
    const title = rootEditor.locator('[data-embed-nav-title]').filter({ hasText: 'Virtual break child' });
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`)).toBeVisible();
    await suffix.click({ position: { x: 1, y: 8 } });
    await page.keyboard.press('ArrowLeft');
    await expect(title.locator('[data-testid="embedded-title-caret"]')).toBeVisible();
    await expect(rootEditor.locator('.cm-embedded-editing')).toHaveCount(0);

    await page.keyboard.press('ArrowRight');
    await expect(title.locator('[data-testid="embedded-title-caret"]')).toHaveCount(0);
    const cursor = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    const [suffixRect, cursorRect] = await Promise.all([
        suffix.evaluate(element => element.getBoundingClientRect().toJSON()),
        cursor.evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(cursorRect.top).toBeLessThan(suffixRect.bottom);
    expect(cursorRect.bottom).toBeGreaterThan(suffixRect.top);

    await page.keyboard.press('ArrowLeft');
    await expect(title.locator('[data-testid="embedded-title-caret"]')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(rootEditor.locator('.cm-embedded-editing')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(title.locator('[data-testid="embedded-title-caret"]')).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await expect(title.locator('[data-testid="embedded-title-caret"]')).toBeVisible();
    await expect(rootEditor.locator('.cm-embedded-editing')).toHaveCount(0);
    await page.keyboard.insertText('X');
    await expect(page.getByText('Xsuffix', { exact: true })).toBeVisible();
});

test('moves up into the visible suffix before an open embedded body', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:up-suffix-child-${stamp}`;
    const sourceLabel = `test:up-suffix-source-${stamp}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Proof child', label: childLabel, content: 'proof first row\nproof last row' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Up suffix source', label: sourceLabel, content: `using [[${childLabel}∨]], we get\nnext parent row` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`)).toBeVisible();
    const nextRow = rootEditor.getByText('next parent row', { exact: true });
    await nextRow.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');

    const caret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary');
    await expectCaretToOverlapRow(caret, rootEditor.getByText(', we get', { exact: true }));
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-focused')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expectCaretToOverlapRow(caret, nextRow);
});

test('moves up to visible prefix text beside a closed inline title', async ({ page }) => {
    const stamp = Date.now();
    const targetLabel = `test:up-closed-inline-target-${stamp}`;
    const sourceLabel = `test:up-closed-inline-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Subadditivity', label: targetLabel, content: 'Referenced result' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Closed inline source',
            label: sourceLabel,
            content: `efefefe [[${targetLabel}||subadditivity]]\nfefefef`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const title = rootEditor.getByText('subadditivity', { exact: true });
    const nextRow = rootEditor.getByText('fefefef', { exact: true });
    await expect(title).toBeVisible();
    await nextRow.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');

    const caret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary');
    await expectCaretToOverlapRow(caret, title);
    const [caretRect, titleRect] = await Promise.all([
        caret.evaluate(element => element.getBoundingClientRect().toJSON()),
        title.evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(caretRect.right).toBeLessThan(titleRect.left - 2);
    await page.keyboard.press('ArrowDown');
    await expectCaretToOverlapRow(caret, nextRow);

    // A horizontal goal near the end of the prefix can map to the title's
    // replacement boundary. It must still stay on the visible prefix side.
    await nextRow.click({ position: { x: 55, y: 8 } });
    await page.keyboard.press('ArrowUp');
    await expectCaretToOverlapRow(caret, title);
    const boundaryCaretRect = await caret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(boundaryCaretRect.right).toBeLessThan(titleRect.left - 2);
    await expect(title.locator('[data-testid="embedded-title-caret"]')).toHaveCount(0);
});

test('moves down to visible suffix text beside a closed inline title', async ({ page }) => {
    const stamp = Date.now();
    const targetLabel = `test:down-closed-inline-target-${stamp}`;
    const sourceLabel = `test:down-closed-inline-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: '0.1 Inline Editing', label: targetLabel, content: 'Referenced result' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Closed inline source',
            label: sourceLabel,
            content: `Try clicking on the chip below, or moving your cursor inside it\nefefefe [[${targetLabel}]] fefefe\nfefefef`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const title = rootEditor.getByText('0.1 Inline Editing', { exact: true });
    const firstRow = rootEditor.getByText('Try clicking on the chip below, or moving your cursor inside it', { exact: true });
    await expect(title).toBeVisible();
    const suffixText = rootEditor.locator('.cm-line').filter({ hasText: 'fefefe' }).first();
    const suffixBounds = () => suffixText.evaluate(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            let result: DOMRect | null = null;
            while ((node = walker.nextNode())) {
                const value = node.nodeValue || '';
                const index = value.lastIndexOf('fefefe');
                if (index < 0) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + 'fefefe'.length);
                result = range.getBoundingClientRect();
            }
            if (result) return result.toJSON();
            throw new Error('Could not find suffix text');
        });
    const suffixRect = await suffixBounds();
    const firstRect = await firstRow.evaluate(element => element.getBoundingClientRect().toJSON());
    await page.mouse.click((suffixRect.left + suffixRect.right) / 2, (firstRect.top + firstRect.bottom) / 2);
    const titleRect = await title.evaluate(element => element.getBoundingClientRect().toJSON());
    const startingCaretRect = await rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(startingCaretRect.left).toBeGreaterThan(titleRect.right + 2);
    await page.keyboard.press('ArrowDown');

    const caret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary');
    // CodeMirror can update its selection before its cursor layer is redrawn.
    // Check the rendered caret after that redraw, against current text bounds.
    await expect.poll(async () => {
        const [caretRect, currentSuffixRect, currentTitleRect] = await Promise.all([
            caret.evaluate(element => element.getBoundingClientRect().toJSON()),
            suffixBounds(),
            title.evaluate(element => element.getBoundingClientRect().toJSON())
        ]);
        return caretRect.top < currentSuffixRect.bottom &&
            caretRect.bottom > currentSuffixRect.top &&
            caretRect.left > currentTitleRect.right + 2;
    }).toBe(true);
    await expect(title.locator('[data-testid="embedded-title-caret"]')).toHaveCount(0);
});

test('moves up from display math into the preceding open embed suffix', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:math-suffix-child-${stamp}`;
    const sourceLabel = `test:math-suffix-source-${stamp}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Math suffix proof', label: childLabel, content: 'proof first row\nproof last row' }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Math suffix source',
            label: sourceLabel,
            content: `using [[${childLabel}∨]], we get\n\\[\nx^2=1\n\\]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`)).toBeVisible();
    const suffix = rootEditor.getByText(', we get', { exact: true });
    await suffix.click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await expect(rootEditor.locator('.cm-math-editing').first()).toBeVisible();
    await page.keyboard.press('ArrowUp');

    const suffixRect = await suffix.evaluate(element => element.getBoundingClientRect().toJSON());
    const caretRect = await rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(caretRect.top).toBeLessThan(suffixRect.bottom);
    expect(caretRect.bottom).toBeGreaterThan(suffixRect.top);
    await expect(page.getByTestId(`embedded-editor-host-${child.id}`).locator('.cm-focused')).toHaveCount(0);
});

test('moves up to the final wrapped row of an open embed suffix', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:wrapped-suffix-child-${stamp}`;
    const sourceLabel = `test:wrapped-suffix-source-${stamp}`;
    const tail = Array.from({ length: 64 }, (_, index) => `suffix-word-${index}`).join(' ');
    await page.request.post('/api/blocks', {
        data: { title: 'Wrapped suffix child', label: childLabel, content: 'child first\nchild last' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Wrapped suffix source', label: sourceLabel, content: `prefix [[${childLabel}∨]] ${tail}\nfollowing row` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const following = rootEditor.getByText('following row', { exact: true });
    await following.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');

    const lastWord = rootEditor.getByText('suffix-word-63', { exact: false });
    const lastWordRect = await lastWord.evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const text = node.nodeValue || '';
            const index = text.indexOf('suffix-word-63');
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 'suffix-word-63'.length);
            return range.getBoundingClientRect().toJSON();
        }
        throw new Error('Could not find the last suffix word');
    });
    const caretRect = await rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(caretRect.top).toBeLessThan(lastWordRect.bottom);
    expect(caretRect.bottom).toBeGreaterThan(lastWordRect.top);
});

test('moves up to text after a closed link following an open embed', async ({ page }) => {
    const stamp = Date.now();
    const openLabel = `test:mixed-suffix-open-${stamp}`;
    const closedLabel = `test:mixed-suffix-closed-${stamp}`;
    const sourceLabel = `test:mixed-suffix-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Mixed open child', label: openLabel, content: 'open body' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Mixed closed child', label: closedLabel, content: 'closed body' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Mixed suffix source', label: sourceLabel,
            content: `prefix [[${openLabel}∨]] middle [[${closedLabel}]] final-tail\nfollowing row`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await rootEditor.getByText('following row', { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    const tailRect = await rootEditor.locator('.cm-line').filter({ hasText: 'final-tail' }).first()
        .evaluate(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) {
                const index = (node.nodeValue || '').indexOf('final-tail');
                if (index < 0) continue;
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + 'final-tail'.length);
                return range.getBoundingClientRect().toJSON();
            }
            throw new Error('Could not find final-tail');
        });
    const caretRect = await rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(caretRect.top).toBeLessThan(tailRect.bottom);
    expect(caretRect.bottom).toBeGreaterThan(tailRect.top);
});

test('moves from an open title directly to the following embedded title', async ({ page }) => {
    const stamp = Date.now();
    const firstLabel = `test:adjacent-first-${stamp}`;
    const secondLabel = `test:adjacent-second-${stamp}`;
    const sourceLabel = `test:adjacent-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'First neighboring title', label: firstLabel, content: 'first body' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Second neighboring title', label: secondLabel, content: 'second body' }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Adjacent source', label: sourceLabel, content: `intro\n[[${firstLabel}∨]][[${secondLabel}]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    await page.getByText('intro', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    const first = page.locator('[data-embed-nav-title]').filter({ hasText: 'First neighboring title' });
    const second = page.locator('[data-embed-nav-title]').filter({ hasText: 'Second neighboring title' });
    await expect(first.getByTestId('embedded-title-caret')).toBeVisible();
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(second.getByTestId('embedded-title-caret')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(first.getByTestId('embedded-title-caret')).toBeVisible();
});

test('enters display math before the following embedded title in a nested editor', async ({ page }) => {
    const stamp = Date.now();
    const proofLabel = `test:math-order-proof-${stamp}`;
    const lemmaLabel = `test:math-order-lemma-${stamp}`;
    const sourceLabel = `test:math-order-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'proof', label: proofLabel, content: 'proof detail' }
    });
    const lemma = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Riemann-Lebesgue lemma',
            label: lemmaLabel,
            content: `For $f\\in L^1$\n\\[\n\\int_{-\\pi}^{\\pi} f(y)\\sin(my)\\,dy=0\n\\]\n[[${proofLabel}∨]]`
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Math order source', label: sourceLabel, content: `[[${lemmaLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const lemmaEditor = page.getByTestId(`embedded-editor-host-${lemma.id}`).locator('.cm-editor').first();
    await expect(lemmaEditor.locator('.cm-math-block')).toBeVisible();
    await lemmaEditor.locator('.cm-line').filter({ hasText: 'For ' }).first().click({ position: { x: 30, y: 12 } });
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await expect(lemmaEditor.locator('.cm-math-editing').first()).toBeVisible();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('reveals only the final caret when moving between a title and a distant inline suffix', async ({ page }) => {
    const stamp = Date.now();
    const childLabel = `test:distant-suffix-child-${stamp}`;
    const sourceLabel = `test:distant-suffix-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Distant suffix child',
            label: childLabel,
            content: Array.from({ length: 55 }, (_, index) => `long child row ${index}`).join('\n')
        }
    });
    await page.request.post('/api/blocks', {
        data: { title: 'Distant suffix source', label: sourceLabel, content: `[[${childLabel}∨]]distant-tail` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const title = panel.locator('[data-embed-nav-title]').filter({ hasText: 'Distant suffix child' });
    const suffix = page.getByText('distant-tail', { exact: true });
    await expect(panel.locator('[data-editor-mounted="true"] .cm-content').first()).toContainText('long child row 0');
    // Establish the distant-body fixture before comparing scroll positions.
    await expect.poll(() => panel.locator('.cm-embedded-block-wrapper[data-embed-part="body"]')
        .evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(1000);
    await suffix.click({ position: { x: 1, y: 8 } });
    await page.keyboard.press('ArrowLeft');
    await expect(title.getByTestId('embedded-title-caret')).toBeVisible();
    await expect(title).toBeInViewport();
    const titleScroll = await panel.evaluate(element => element.scrollTop);

    await page.keyboard.press('ArrowRight');
    await expect(suffix).toBeInViewport();
    const suffixScroll = await panel.evaluate(element => element.scrollTop);
    expect(suffixScroll).toBeGreaterThan(titleScroll + 200);

    await page.keyboard.press('ArrowLeft');
    await expect(title.getByTestId('embedded-title-caret')).toBeVisible();
    await expect(title).toBeInViewport();
});

test('visits wrapped text before adjacent display math and then enters the equation', async ({ page }) => {
    const stamp = Date.now();
    const proofLabel = `test:wrapped-math-proof-${stamp}`;
    const sourceLabel = `test:wrapped-math-source-${stamp}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Following proof', label: proofLabel, content: 'proof body' }
    });
    const longLine = Array.from({ length: 48 }, (_, index) => `wrapped-word-${index}`).join(' ');
    await page.request.post('/api/blocks', {
        data: {
            title: 'Wrapped math source',
            label: sourceLabel,
            content: `${longLine}\n\\[\nx^2+y^2=1\n\\]\n[[${proofLabel}]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const wrappedLine = editor.locator(':scope > .cm-scroller > .cm-content > .cm-line').filter({ hasText: 'wrapped-word-0' });
    const rect = await wrappedLine.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(rect.height).toBeGreaterThan(50);
    await wrappedLine.click({ position: { x: 12, y: 10 } });
    await page.keyboard.press('ArrowDown');
    await expect(editor.locator('.cm-math-editing')).toHaveCount(0);

    await wrappedLine.click({ position: { x: 12, y: rect.height - 8 } });
    await page.keyboard.press('ArrowDown');
    await expect(editor.locator('.cm-math-editing').first()).toBeVisible();
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
});

test('enters display math from below without any embedded links', async ({ page }) => {
    const sourceLabel = `test:math-up-source-${Date.now()}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Math up source', label: sourceLabel, content: 'before\n\\[\nx^2=1\n\\]\nafter' }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await page.getByText('after', { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    await expect(editor.locator('.cm-math-editing').first()).toBeVisible();
});

test('does not leave an empty continuation row after an end-of-line open inline embed', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:inline-no-suffix-child-${suffix}`;
    const sourceLabel = `test:inline-no-suffix-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: { title: 'Inline no suffix child', label: childLabel, content: 'embedded final row' }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Inline no suffix source',
            label: sourceLabel,
            content: `before-label [[${childLabel}∨]]\nparent row after embed`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const body = page.getByTestId(`embedded-editor-host-${child.id}`);
    const finalRow = page.getByText('embedded final row', { exact: true });
    const followingRow = page.getByText('parent row after embed', { exact: true });
    await expect(body).toBeVisible();
    await expect(followingRow).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ));

    const [bodyRect, finalRect, followingRect] = await Promise.all([
        body.evaluate(element => element.getBoundingClientRect().toJSON()),
        finalRow.evaluate(element => element.getBoundingClientRect().toJSON()),
        followingRow.evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(followingRect.top).toBeGreaterThanOrEqual(bodyRect.bottom - 2);
    expect(followingRect.top - finalRect.bottom).toBeLessThan(45);

    // Boundary navigation must keep the same visual order after removing the
    // empty continuation: child final row -> following parent row -> child.
    await finalRow.click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    await expect(rootEditor.locator(':scope > .cm-scroller > .cm-content:focus')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(body.locator('.cm-content:focus')).toHaveCount(1);
});

test('keeps a small measured bottom inset on terminal normal and standout embeds', async ({ page }) => {
    const stamp = Date.now();
    const normalLabel = `test:terminal-normal-${stamp}`;
    const standoutLabel = `test:terminal-standout-${stamp}`;
    const sourceLabel = `test:terminal-padding-source-${stamp}`;
    const normal = await (await page.request.post('/api/blocks', {
        data: { title: 'Terminal normal', label: normalLabel, content: 'normal final row' }
    })).json();
    const standout = await (await page.request.post('/api/blocks', {
        data: { title: 'Terminal standout', label: standoutLabel, content: 'standout final row' }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Terminal padding source', label: sourceLabel,
            content: `[[${normalLabel}∨]]\n[[@${standoutLabel}∨]]\nfollowing parent row` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    for (const id of [normal.id, standout.id]) {
        const host = page.getByTestId(`embedded-editor-host-${id}`);
        await expect(host).toBeVisible();
        expect(await host.evaluate(element => {
            const body = element.closest<HTMLElement>('[data-embed-nav-body]');
            return body ? getComputedStyle(body).paddingBottom : null;
        })).toBe('4px');
    }
    const following = page.getByText('following parent row', { exact: true });
    const lastChildRow = page.getByText('standout final row', { exact: true });
    await expect(lastChildRow).toBeVisible();
    await expect.poll(() => following.evaluate((element, selector) => {
        const last = document.querySelector(selector)?.getBoundingClientRect();
        if (!last) return false;
        const gap = element.getBoundingClientRect().top - last.bottom;
        return gap >= 0 && gap < 45;
    }, '[data-testid="embedded-editor-host-' + standout.id + '"] .cm-line')).toBe(true);
});

test('crosses arbitrarily nested bottom boundaries to the inline suffix in one Down press', async ({ page }) => {
    const suffix = Date.now();
    const leafLabel = `test:bottom-walk-leaf-${suffix}`;
    const middleLabel = `test:bottom-walk-middle-${suffix}`;
    const outerLabel = `test:bottom-walk-outer-${suffix}`;
    const sourceLabel = `test:bottom-walk-source-${suffix}`;
    const leaf = await (await page.request.post('/api/blocks', {
        data: { title: 'Bottom walk leaf', label: leafLabel, content: 'deepest final row' }
    })).json();
    const middle = await (await page.request.post('/api/blocks', {
        data: { title: 'Bottom walk middle', label: middleLabel, content: `[[${leafLabel}∨]]` }
    })).json();
    const outer = await (await page.request.post('/api/blocks', {
        data: { title: 'Bottom walk outer', label: outerLabel, content: `[[${middleLabel}∨]]` }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Bottom walk source',
            label: sourceLabel,
            content: `before-boundary [[${outerLabel}∨]] after-boundary`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const ownFocusedContent = (id: string) => page.getByTestId(`embedded-editor-host-${id}`)
        .locator('.cm-content:focus');
    await expect(page.getByText('Bottom walk outer', { exact: true })).toBeVisible();
    await expect(page.getByText('Bottom walk middle', { exact: true })).toBeVisible();
    await expect(page.getByText('Bottom walk leaf', { exact: true })).toBeVisible();
    await expect(page.getByText('deepest final row', { exact: true })).toBeVisible();

    // Down from the deepest final visible row climbs every exhausted parent
    // and reaches the outer inline suffix in one keypress.
    await page.getByText('deepest final row', { exact: true }).click();
    await page.keyboard.press('End');
    await expect(ownFocusedContent(leaf.id)).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(rootEditor.locator(':scope > .cm-scroller > .cm-content:focus')).toHaveCount(1);
    await expect(ownFocusedContent(leaf.id)).toHaveCount(0);

    const [cursorRect, suffixRect] = await Promise.all([
        rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')
            .evaluate(element => element.getBoundingClientRect().toJSON()),
        page.getByText('after-boundary', { exact: true })
            .evaluate(element => element.getBoundingClientRect().toJSON())
    ]);
    expect(cursorRect.top).toBeLessThan(suffixRect.bottom);
    expect(cursorRect.bottom).toBeGreaterThan(suffixRect.top);

    // Up is the inverse transition and descends through the final open child
    // of every ancestor without stopping on hidden source boundaries.
    await page.keyboard.press('ArrowUp');
    await expect(ownFocusedContent(leaf.id)).toHaveCount(1);

    // The round trip remains reversible.
    await page.keyboard.press('ArrowDown');
    await expect(rootEditor.locator(':scope > .cm-scroller > .cm-content:focus')).toHaveCount(1);
    await expect(ownFocusedContent(leaf.id)).toHaveCount(0);
});

test('moves through wrapped rows beside an expanded title without jumping to a later embed', async ({ page }) => {
    const suffix = Date.now();
    const proofLabel = `test:wrapped-proof-${suffix}`;
    const laterLabel = `test:wrapped-later-${suffix}`;
    const sourceLabel = `test:wrapped-navigation-source-${suffix}`;
    const proof = await (await page.request.post('/api/blocks', {
        data: {
            title: 'proof',
            label: proofLabel,
            content: Array.from({ length: 24 }, (_, index) => `proof row ${index}`).join('\n')
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Application to Laplace and Poisson equations on unit disk',
            label: laterLabel,
            content: 'later embedded content'
        }
    });
    const wrappedRow = `3. ${Array.from({ length: 34 }, (_, index) => `estimate-${index}`).join(' ')} independent of m.`;
    await page.request.post('/api/blocks', {
        data: {
            title: 'Wrapped navigation source',
            label: sourceLabel,
            content: `${wrappedRow}\n[[@${proofLabel}∨]]\n[[@${laterLabel}∨]]`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    // The expanded child changes the panel's scrollbar geometry when it first
    // mounts. Wait for that real layout before measuring wrapped-row movement;
    // otherwise this test can confuse initial editor layout with a keypress.
    await expect(page.getByTestId(`embedded-editor-host-${proof.id}`).locator('.cm-editor')).toBeVisible();
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const nativeCaret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    const wrappedLine = page.getByText(wrappedRow, { exact: true });
    const wrappedLineBox = await wrappedLine.boundingBox();
    expect(wrappedLineBox).not.toBeNull();
    await wrappedLine.click({
        position: {
            x: Math.max(2, wrappedLineBox!.width - 4),
            y: Math.max(2, wrappedLineBox!.height - 4)
        }
    });
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toContainText('Proof');

    // Up from the proof title reaches the immediately preceding rendered wrap.
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect(nativeCaret).toBeVisible();
    const proofTitleRect = await page.getByText('Proof', { exact: true }).evaluate(element => element.getBoundingClientRect().toJSON());
    const lowerWrapRect = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    const editorLineHeight = await rootEditor.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize) * 1.6);
    expect(proofTitleRect.top - lowerWrapRect.bottom).toBeLessThan(editorLineHeight * 3);
    expect(lowerWrapRect.height).toBeLessThanOrEqual(editorLineHeight + 2);

    // One more Up and Down traverse adjacent wraps, rather than selecting the
    // much later Application embed or exposing a replacement-height caret.
    await page.keyboard.press('ArrowUp');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const upperWrapRect = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(upperWrapRect.top).toBeLessThan(lowerWrapRect.top - 2);
    await page.keyboard.press('ArrowDown');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const returnedWrapRect = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(Math.abs(returnedWrapRect.top - lowerWrapRect.top)).toBeLessThanOrEqual(2);
    await expect(page.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    const selectedTitle = page.locator('[data-embed-keyboard-selected="true"]');
    await expect(selectedTitle).toContainText('Proof');
    await expect(selectedTitle).not.toContainText('Application to Laplace and Poisson equations on unit disk');
    await expect(selectedTitle.getByTestId('embedded-title-caret')).toBeVisible();
    await expect(nativeCaret).toBeHidden();
});

test('keeps fresh vertical movement inside wrapped text before and after an inline embed', async ({ page }) => {
    const suffix = Date.now();
    const targetLabel = `test:fresh-wrap-target-${suffix}`;
    const sourceLabel = `test:fresh-wrap-source-${suffix}`;
    const prefix = Array.from({ length: 28 }, (_, index) => `prefix-${index}`).join(' ');
    const trailing = Array.from({ length: 28 }, (_, index) => `suffix-${index}`).join(' ');
    await page.request.post('/api/blocks', {
        data: { title: 'Fresh wrapped portal', label: targetLabel, content: 'embedded body row' }
    });
    await page.request.post('/api/blocks', {
        data: {
            title: 'Fresh wrapped source',
            label: sourceLabel,
            content: `${prefix} [[@${targetLabel}∨]] ${trailing}`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const rootEditor = panel.locator('.cm-editor').first();
    const rootContent = rootEditor.locator(':scope > .cm-scroller > .cm-content');
    const nativeCaret = rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    const prefixLine = rootContent.locator(':scope > .cm-line').filter({ hasText: 'prefix-0' });
    const prefixRect = await prefixLine.evaluate(element => element.getBoundingClientRect().toJSON());
    const lineHeight = await rootEditor.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize) * 1.6);
    expect(prefixRect.height).toBeGreaterThan(lineHeight * 1.5);

    // This begins with a pointer gesture, so no cached reverse move can hide a
    // fresh Down failure. The next destination is the second visible wrap,
    // even though CodeMirror's native candidate can be the embed boundary.
    await prefixLine.click({ position: { x: 120, y: Math.min(8, prefixRect.height / 4) } });
    await expect.poll(() => nativeCaret.evaluate(element => element.getBoundingClientRect().top))
        .toBeLessThan(prefixRect.top + lineHeight);
    const firstWrapCaret = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    await page.keyboard.press('ArrowDown');
    await expect(rootContent).toBeFocused();
    await expect(panel.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect.poll(() => nativeCaret.evaluate(element => element.getBoundingClientRect().top))
        .toBeGreaterThan(firstWrapCaret.top + 2);
    const secondWrapCaret = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(secondWrapCaret.top).toBeGreaterThan(firstWrapCaret.top + 2);
    const titleRect = await page.locator('[role="tabpanel"][aria-hidden="false"]').getByText('Fresh wrapped portal', { exact: true })
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(secondWrapCaret.bottom).toBeLessThan(titleRect.top + 2);

    // The inverse case starts freshly on the final wrapped suffix row. Up must
    // visit the preceding suffix wrap before the open child body/title portal.
    const suffixLine = rootContent.locator(':scope > .cm-line').filter({ hasText: 'suffix-0' });
    const suffixRect = await suffixLine.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(suffixRect.height).toBeGreaterThan(lineHeight * 1.5);
    await suffixLine.click({
        position: {
            x: 120,
            y: Math.max(4, suffixRect.height - 8)
        }
    });
    // CodeMirror paints its caret layer in a later measurement frame. Wait
    // until the clicked final wrap is painted before recording the baseline;
    // otherwise the previous prefix caret can make a correct Up move fail.
    await expect.poll(() => nativeCaret.evaluate(element => element.getBoundingClientRect().top))
        .toBeGreaterThan(suffixRect.bottom - lineHeight - 2);
    const finalSuffixCaret = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    await page.keyboard.press('ArrowUp');
    await expect(rootContent).toBeFocused();
    await expect(panel.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    await expect.poll(() => nativeCaret.evaluate(element => element.getBoundingClientRect().top))
        .toBeLessThan(finalSuffixCaret.top - 2);
    const priorSuffixCaret = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(priorSuffixCaret.top).toBeLessThan(finalSuffixCaret.top - 2);
    expect(priorSuffixCaret.top).toBeGreaterThan(titleRect.bottom - 2);
});

test('keeps fresh wrapped-row navigation inside a nested editor with inline math', async ({ page }) => {
    const suffix = Date.now();
    const leafLabel = `test:nested-wrap-leaf-${suffix}`;
    const childLabel = `test:nested-wrap-child-${suffix}`;
    const sourceLabel = `test:nested-wrap-source-${suffix}`;
    const wrappedPrefix = `Start with $x^2$ and ${Array.from({ length: 30 }, (_, index) => `estimate-${index}`).join(' ')}`;
    await page.request.post('/api/blocks', {
        data: { title: 'Nested wrapped leaf', label: leafLabel, content: 'leaf body' }
    });
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Nested wrapped child',
            label: childLabel,
            content: `${wrappedPrefix} [[@${leafLabel}∨]]`
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Nested wrapped source', label: sourceLabel, content: `[[${childLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const childHost = page.getByTestId(`embedded-editor-host-${child.id}`);
    const childEditor = childHost.locator('.cm-editor').first();
    const childContent = childEditor.locator(':scope > .cm-scroller > .cm-content');
    const prefixLine = childContent.locator(':scope > .cm-line').filter({ hasText: 'estimate-0' });
    const nativeCaret = childEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary').first();
    const prefixRect = await prefixLine.evaluate(element => element.getBoundingClientRect().toJSON());
    const lineHeight = await childEditor.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize) * 1.6);
    expect(prefixRect.height).toBeGreaterThan(lineHeight * 1.5);

    await prefixLine.click({ position: { x: 180, y: 8 } });
    const firstWrapCaret = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    await page.keyboard.press('ArrowDown');
    await expect(childContent).toBeFocused();
    await expect(childHost.locator('[data-embed-keyboard-selected="true"]')).toHaveCount(0);
    const secondWrapCaret = await nativeCaret.evaluate(element => element.getBoundingClientRect().toJSON());
    expect(secondWrapCaret.top).toBeGreaterThan(firstWrapCaret.top + 2);
    const leafTitleRect = await page.locator('[role="tabpanel"][aria-hidden="false"]').getByText('Nested wrapped leaf', { exact: true })
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(secondWrapCaret.bottom).toBeLessThan(leafTitleRect.top + 2);
});

test('visits the nearest visible suffix before its nested embed, not an earlier link', async ({ page }) => {
    const suffix = Date.now();
    const unrelatedLabel = `test:visual-up-unrelated-${suffix}`;
    const proofLabel = `test:visual-up-proof-${suffix}`;
    const visibleLabel = `test:visual-up-visible-${suffix}`;
    const sourceLabel = `test:visual-up-source-${suffix}`;
    const unrelated = await (await page.request.post('/api/blocks', {
        data: { title: 'Earlier unrelated inline link', label: unrelatedLabel, content: 'unrelated body' }
    })).json();
    const proof = await (await page.request.post('/api/blocks', {
        data: { title: 'Visible proof', label: proofLabel, content: 'proof final row' }
    })).json();
    const visible = await (await page.request.post('/api/blocks', {
        data: { title: 'Nearest visible embed', label: visibleLabel, content: `visible opening\n[[${proofLabel}∨]]` }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Visual Up source',
            label: sourceLabel,
            content: `intro\n[[${unrelatedLabel}]]\nusing [[${visibleLabel}∨]], we get\nafter the visible embed`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    // The parent row following the projected body first reaches the visible
    // continuation of the preceding source line. One more Up enters the
    // nearest child's final row, never the unrelated earlier link.
    const suffixText = page.getByText('after the visible embed', { exact: true });
    await suffixText.click({ position: { x: 3, y: 8 } });
    await page.keyboard.press('ArrowUp');

    const rootEditor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-editor').first();
    const continuationRect = await rootEditor.getByText(', we get', { exact: true })
        .evaluate(element => element.getBoundingClientRect().toJSON());
    const caretRect = await rootEditor.locator(':scope > .cm-scroller > .cm-layer .cm-cursor-primary')
        .evaluate(element => element.getBoundingClientRect().toJSON());
    expect(caretRect.top).toBeLessThan(continuationRect.bottom);
    expect(caretRect.bottom).toBeGreaterThan(continuationRect.top);

    await page.keyboard.press('ArrowUp');

    const visibleHost = page.getByTestId(`embedded-editor-host-${visible.id}`);
    await expect(visibleHost.locator('.cm-content:focus')).toHaveCount(1);
    await expect(page.getByTestId(`embedded-editor-host-${proof.id}`).locator('.cm-content:focus')).toHaveCount(1);
    await expect(page.getByText('Earlier unrelated inline link', { exact: true })).not.toHaveAttribute('data-embed-keyboard-selected', 'true');
    await expect(page.getByTestId(`embedded-editor-host-${unrelated.id}`)).toHaveCount(0);
});

test('renders inline math and continues Markdown markers with Enter', async ({ page }) => {
    const editor = await openEditor(page);

    await replaceEditorText(page, editor, 'Text with $x^2$ inline math');
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-inline .katex')).toBeVisible();
    await page.keyboard.press('Escape');

    for (const [source, expected] of [
        ['* first', '* first\n* second\n'],
        ['1. first', '1. first\n2. second\n'],
        ['> first', '> first\n> second\n']
    ]) {
        const saveRequest = page.waitForRequest(request => {
            if (request.method() !== 'PUT' || !request.url().includes('/api/blocks/')) return false;
            return request.postDataJSON()?.content === expected;
        });
        await replaceEditorText(page, editor, source);
        await page.keyboard.press('Enter');
        await page.keyboard.insertText('second');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.getByLabel('Open settings').click();
        expect((await saveRequest).postDataJSON().content).toBe(expected);
        await page.keyboard.press('Escape');
    }
});

test('right-clicking a Markdown link does not open it', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '[Example](https://example.com)');
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');

    await page.evaluate(() => {
        (window as any).__openedLinks = [];
        window.open = ((url: string) => {
            (window as any).__openedLinks.push(url);
            return null;
        }) as typeof window.open;
    });
    const link = editor.locator('.cm-markdown-link');
    await expect(link).toBeVisible();
    await link.click({ button: 'right' });
    expect(await page.evaluate(() => (window as any).__openedLinks)).toEqual([]);
});

test('loads note bodies on demand while keeping the block index metadata-only', async ({ page }) => {
    const runtime = await page.request.get('/api/runtime');
    expect(await runtime.json()).toMatchObject({ testMode: true, desktop: false });

    const metadataResponse = await page.request.get('/api/blocks?metaOnly=true');
    expect(metadataResponse.ok()).toBeTruthy();
    const metadata = await metadataResponse.json();
    expect(metadata.length).toBeGreaterThan(0);
    expect(metadata.every((block: Record<string, unknown>) => !('content' in block))).toBeTruthy();
    expect(metadata.every((block: Record<string, unknown>) => typeof block.hasContent === 'boolean')).toBeTruthy();

    const contentResponse = await page.request.get(`/api/blocks/${metadata[0].id}`);
    expect(contentResponse.ok()).toBeTruthy();
    expect(typeof (await contentResponse.json()).content).toBe('string');
});

test('preserves reference cascades when lazily loaded block labels change', async ({ page }) => {
    const suffix = Date.now();
    const originalLabel = `test:lazy-target-${suffix}`;
    const targetBlock = await (await page.request.post('/api/blocks', {
        data: { title: 'Lazy target', label: originalLabel, content: '$x$' }
    })).json();
    const source = await (await page.request.post('/api/blocks', {
        data: { title: 'Lazy source', label: `test:lazy-source-${suffix}`, content: `before [[${originalLabel}]] after` }
    })).json();
    const renamedLabel = `test:lazy-renamed-${suffix}`;
    const preview = await (await page.request.post('/api/relabel/preview', {
        data: { oldPrefix: originalLabel, newPrefix: renamedLabel }
    })).json();
    const response = await page.request.post('/api/relabel/commit', {
        data: { oldPrefix: originalLabel, newPrefix: renamedLabel, revision: preview.revision }
    });
    expect(response.ok()).toBeTruthy();

    const sourceAfterRename = await (await page.request.get(`/api/blocks/${source.id}`)).json();
    expect(sourceAfterRename.content).toContain(`[[${renamedLabel}]]`);
    expect(sourceAfterRename.content).not.toContain(`[[${originalLabel}]]`);
});

test('preserves parsed math around an incrementally edited line', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'before $a^2$\nchange here\nafter $\\frac{b}{c}$');

    await editor.locator('.cm-line').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' safely');
    await page.getByLabel('Open settings').click();

    await expect(page.locator('.cm-math-inline .katex')).toHaveCount(2);
    await expect(editor).toContainText('change here safely');
    await page.keyboard.press('Escape');
});

test('keeps adjacent dollars as empty inline math instead of block math', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'top $a$\ninside $$ line\nbottom $b$');

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.insertText(' safely');
    await page.getByLabel('Open settings').click();

    await expect(page.locator('.cm-math-block')).toHaveCount(0);
    await expect(page.locator('.cm-math-inline .katex')).toHaveCount(2);
    await expect(page.locator('.cm-math-editing')).toContainText('$$');
    await page.keyboard.press('Escape');
});

test('renders and edits display math without crashing the editor', async ({ page }) => {
    const editorErrors: string[] = [];
    page.on('pageerror', error => {
        if (/Block decorations|No tile at position|coordsAt/.test(error.message)) {
            editorErrors.push(error.message);
        }
    });
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'Before display math\n\\[\n\\int_0^1 t^2 \\,dt\n\\]\nAfter display math');

    // Blurring replaces the source range with a block KaTeX widget.
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-block .katex')).toBeVisible();
    await expect(editor).toContainText('Before display math');
    await expect(editor).toContainText('After display math');
    await page.keyboard.press('Escape');

    // Activating it restores the source and keeps the block preview visible.
    await page.locator('.cm-math-block').click();
    await expect(editor).toContainText('\\int_0^1 t^2');
    await expect(page.locator('.cm-math-block .katex')).toBeVisible();
    expect(editorErrors).toEqual([]);
});

test('removes display-math editing space after the cursor leaves the formula', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, 'Before display math\n\\[\\frac{1}{1+x^2}\\]\nAfter display math\nFinal line');
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');

    const rendered = page.locator('.cm-math-rendered').first();
    await expect(rendered).toBeVisible();
    const initial = await editor.evaluate(element => ({
        height: element.getBoundingClientRect().height,
        scrollHeight: element.scrollHeight,
        blockCount: element.querySelectorAll('.cm-math-block').length
    }));

    await rendered.click();
    await expect(editor).toContainText('\\frac{1}{1+x^2}');
    await editor.locator('.cm-line').last().click();
    await expect(page.locator('.cm-math-rendered')).toBeVisible();
    await page.waitForTimeout(100);

    const after = await editor.evaluate(element => ({
        height: element.getBoundingClientRect().height,
        scrollHeight: element.scrollHeight,
        blockCount: element.querySelectorAll('.cm-math-block').length,
        editingCount: element.querySelectorAll('.cm-math-editing').length
    }));
    expect(after.blockCount).toBe(initial.blockCount);
    expect(after.editingCount).toBe(0);
    expect(Math.abs(after.height - initial.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.scrollHeight - initial.scrollHeight)).toBeLessThanOrEqual(2);
});

test('does not retain transient display-math editing height in an embedded block', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:math-height-child-${suffix}`;
    const sourceLabel = `test:math-height-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Math height child',
            label: childLabel,
            content: 'Before display math\n\\[\n\\frac{\\displaystyle\\sum_{i=1}^n i^2}{1+x^2}\n\\]\nAfter display math'
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Math height source', label: sourceLabel, content: `[[${childLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const host = page.getByTestId(`embedded-editor-host-${child.id}`);
    const wrapper = host.locator('xpath=ancestor::*[contains(@class,"cm-embedded-block-wrapper")][1]');
    const rendered = host.locator('.cm-math-rendered');
    await expect(rendered).toBeVisible();
    await expect.poll(() => wrapper.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(40);
    const initialHeight = await wrapper.evaluate(element => element.getBoundingClientRect().height);

    await rendered.click();
    await expect(host.locator('.cm-math-editing')).toHaveCount(3);
    await host.locator('.cm-line').last().click();
    await expect(host.locator('.cm-math-editing')).toHaveCount(0);
    await page.waitForTimeout(150);

    const after = await wrapper.evaluate(element => ({
        height: element.getBoundingClientRect().height,
        minHeight: getComputedStyle(element).minHeight
    }));
    expect(Number.parseFloat(after.minHeight)).toBeLessThanOrEqual(initialHeight + 2);
    expect(Math.abs(after.height - initialHeight)).toBeLessThanOrEqual(2);
});

test('repairs a stale embedded height after scrolling and editing become idle', async ({ page }) => {
    const suffix = Date.now();
    const childLabel = `test:height-repair-child-${suffix}`;
    const sourceLabel = `test:height-repair-source-${suffix}`;
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Height repair child',
            label: childLabel,
            content: 'Before\n\\[x^2+y^2\\]\nAfter'
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: { title: 'Height repair source', label: sourceLabel, content: `[[${childLabel}∨]]` }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const host = page.getByTestId(`embedded-editor-host-${child.id}`);
    const wrapper = host.locator('xpath=ancestor::*[contains(@class,"cm-embedded-block-wrapper")][1]');
    const rendered = host.locator('.cm-math-rendered');
    await expect(rendered).toBeVisible();
    const naturalHeight = await wrapper.evaluate(element => element.getBoundingClientRect().height);

    await rendered.click();
    await expect(host.locator('.cm-math-editing')).toHaveCount(1);
    await wrapper.evaluate((element, height) => {
        (element as HTMLElement).style.minHeight = `${height + 700}px`;
    }, naturalHeight);
    await host.locator('.cm-line').last().click();
    await expect(host.locator('.cm-math-editing')).toHaveCount(0);

    await expect.poll(
        () => wrapper.evaluate(element => element.getBoundingClientRect().height),
        { timeout: 2500 }
    ).toBeLessThanOrEqual(naturalHeight + 2);
});

for (const lateViewportMeasurement of [false, true]) {
test(`reopened nested math content does not hold a large visible bottom reservation${lateViewportMeasurement ? ' after delayed viewport measurement' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const stamp = Date.now();
    const proofLabel = `test:reopen-gap-proof-${stamp}`;
    const conditionLabel = `test:reopen-gap-condition-${stamp}`;
    const sourceLabel = `test:reopen-gap-source-${stamp}`;
    const proofContent = Array.from({ length: 9 }, (_, index) => [
        `Step ${index}: $F_m(r)=\\frac{1}{2\\pi}\\int_{-\\pi}^{\\pi}u(re^{i\\theta})e^{-im\\theta}d\\theta$.`,
        `The coefficient is smooth for $r>0$ and depends on the ${index}-th radial derivative.`,
        '',
        '\\[',
        '\\begin{align*}',
        `\\partial_r^{${index}} F_m(r) &= \\frac{1}{2\\pi}\\int_{-\\pi}^{\\pi}\\partial_r^{${index}}u(re^{i\\theta})e^{-im\\theta}d\\theta\\\\`,
        `&= \\frac{1}{(im)^k}\\int_{-\\pi}^{\\pi}\\partial_\\theta^k\\partial_r^{${index}}u(r,\\theta)e^{-im\\theta}d\\theta\\\\`,
        `&\\le C_{k,${index}}\\sup_{\\theta\\in[-\\pi,\\pi]}|\\partial_r^{${index}}u(r,\\theta)|.`,
        '\\end{align*}',
        '\\]',
        `Consequently $|F_m(r)|\\le C_{${index}}|m|^{-k}$, provided the corresponding derivatives remain bounded.`,
        ''
    ].join('\n')).join('\n');
    const proof = await (await page.request.post('/api/blocks', {
        data: { title: 'Height gap proof', label: proofLabel, content: proofContent }
    })).json();
    const condition = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Height gap condition', label: conditionLabel,
            content: [
                '$u(x,y)$ is smooth on the disk if each Fourier coefficient has a regular extension.',
                '1. $u=\\sum_{m\\in\\mathbb Z} F_m(r)e^{im\\theta}$.',
                '2. $F_m(r)=r^{|m|}\\phi_m(r^2)$ for a smooth function $\\phi_m$.',
                '3. $|\\partial_r^jF_m(r)|\\le C_{k,j}(r_0)|m|^{-k}$ uniformly on compact disks.',
                `[[@${proofLabel}∨]]`
            ].join('\n')
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Height gap source', label: sourceLabel,
            content: [
                'We study the unit disk with polar coordinates $z=re^{i\\theta}$.',
                'For each integer $m$, the coefficient is an angular integral with several derivatives.',
                '',
                'The next block gives a smoothness criterion for the resulting expansion.',
                `[[@${conditionLabel}∨]]`
            ].join('\n')
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const title = panel.locator('[data-embed-nav-title]').filter({ hasText: 'Height gap condition' });
    const conditionHost = page.getByTestId(`embedded-editor-host-${condition.id}`);
    const proofHost = page.getByTestId(`embedded-editor-host-${proof.id}`);
    await expect(proofHost.locator('.cm-editor')).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });

    await title.click();
    await expect(conditionHost).toHaveCount(0);
    await title.click();
    await expect(proofHost.locator('.cm-editor')).toBeVisible();
    // The renderer can become ready long after the user's reopening action.
    // A deadline measured from that click must not disable its first refinement.
    if (lateViewportMeasurement) await page.waitForTimeout(1400);
    const settling = await panel.evaluate(async (element, ids) => {
        const gap = (id: string) => {
            const host = document.querySelector(`[data-testid="embedded-editor-host-${id}"]`);
            const wrapper = host?.closest('.cm-embedded-block-wrapper');
            const mount = wrapper?.querySelector(':scope > .cm-embedded-react-mount');
            return wrapper && mount
                ? wrapper.getBoundingClientRect().height - mount.getBoundingClientRect().height
                : 0;
        };
        element.scrollTop = element.scrollHeight;
        const start = performance.now();
        let firstLarge: number | null = null;
        let lastLarge: number | null = null;
        let maxGap = 0;
        await new Promise<void>(resolve => {
            const sample = () => {
                const now = performance.now();
                const current = Math.max(gap(ids.condition), gap(ids.proof));
                maxGap = Math.max(maxGap, current);
                if (current > 20) {
                    firstLarge ??= now;
                    lastLarge = now;
                }
                if (now - start >= 650 || (lastLarge !== null && now - lastLarge >= 60)) {
                    resolve();
                } else {
                    requestAnimationFrame(sample);
                }
            };
            requestAnimationFrame(sample);
        });
        return { maxGap, largeGapDuration: firstLarge !== null && lastLarge !== null
            ? lastLarge - firstLarge : 0, finalGap: Math.max(gap(ids.condition), gap(ids.proof)) };
    }, { condition: condition.id, proof: proof.id });
    expect(settling.largeGapDuration).toBeLessThanOrEqual(180);
    expect(settling.finalGap).toBeLessThanOrEqual(20);
});
}

test('releases retained parent height when a nested block is collapsed', async ({ page }) => {
    const suffix = Date.now();
    const grandchildLabel = `test:toggle-shrink-grandchild-${suffix}`;
    const childLabel = `test:toggle-shrink-child-${suffix}`;
    const sourceLabel = `test:toggle-shrink-source-${suffix}`;
    const grandchild = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Toggle shrink grandchild',
            label: grandchildLabel,
            content: Array.from({ length: 28 }, (_, index) => `grandchild row ${index}`).join('\n')
        }
    })).json();
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Toggle shrink child',
            label: childLabel,
            content: `before\n[[${grandchildLabel}∨]]\nafter`
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Toggle shrink source',
            label: sourceLabel,
            content: `prefix [[${childLabel}∨]] suffix\nparent after`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const childHost = page.getByTestId(`embedded-editor-host-${child.id}`).filter({ visible: true }).last();
    const childWrapper = childHost.locator('xpath=ancestor::*[contains(@class,"cm-embedded-block-wrapper")][1]');
    await expect(page.getByTestId(`embedded-editor-host-${grandchild.id}`)).toBeVisible();
    const expandedHeight = await childWrapper.evaluate(element => element.getBoundingClientRect().height);

    await page.getByText('Toggle shrink grandchild', { exact: true }).click();
    await expect(page.getByTestId(`embedded-editor-host-${grandchild.id}`)).toHaveCount(0);
    await expect.poll(async () => childWrapper.evaluate(element => {
        const mount = element.querySelector<HTMLElement>(':scope > .cm-embedded-react-mount');
        return element.getBoundingClientRect().height - (mount?.getBoundingClientRect().height || 0);
    }), { timeout: 2500 }).toBeLessThanOrEqual(10);
    const collapsed = await childWrapper.evaluate(element => {
        const mount = element.querySelector<HTMLElement>(':scope > .cm-embedded-react-mount');
        return {
            wrapper: element.getBoundingClientRect().height,
            mount: mount?.getBoundingClientRect().height || 0,
            minHeight: Number.parseFloat(getComputedStyle(element).minHeight) || 0
        };
    });
    expect(collapsed.wrapper).toBeLessThan(expandedHeight - 200);
    // The inline body intentionally contributes 4px top and bottom margins.
    expect(Math.abs(collapsed.wrapper - collapsed.mount)).toBeLessThanOrEqual(10);
    expect(collapsed.minHeight).toBeLessThanOrEqual(collapsed.mount + 2);
});

test('does not restore an expanded height when collapse is followed by viewport removal', async ({ page }) => {
    const suffix = Date.now();
    const grandchildLabel = `test:offscreen-collapse-grandchild-${suffix}`;
    const childLabel = `test:offscreen-collapse-child-${suffix}`;
    const sourceLabel = `test:offscreen-collapse-source-${suffix}`;
    const grandchild = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Offscreen collapse grandchild',
            label: grandchildLabel,
            content: Array.from({ length: 45 }, (_, index) => `expanded row ${index}`).join('\n')
        }
    })).json();
    const child = await (await page.request.post('/api/blocks', {
        data: {
            title: 'Offscreen collapse child',
            label: childLabel,
            content: `child before\n[[${grandchildLabel}∨]]\nchild after`
        }
    })).json();
    await page.request.post('/api/blocks', {
        data: {
            title: 'Offscreen collapse source',
            label: sourceLabel,
            content: `${Array.from({ length: 45 }, (_, index) => `before ${index}`).join('\n')}\n[[${childLabel}∨]]\n${Array.from({ length: 90 }, (_, index) => `after ${index}`).join('\n')}`
        }
    });

    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(sourceLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const childHost = page.getByTestId(`embedded-editor-host-${child.id}`).filter({ visible: true }).last();
    const childWrapper = childHost.locator('xpath=ancestor::*[contains(@class,"cm-embedded-block-wrapper")][1]');
    const grandchildTitle = page.getByText('Offscreen collapse grandchild', { exact: true });
    await grandchildTitle.scrollIntoViewIfNeeded();
    const childScrollTop = await panel.evaluate(element => element.scrollTop);
    const expandedHeight = await childWrapper.evaluate(element => element.getBoundingClientRect().height);

    await grandchildTitle.click();
    await expect(page.getByTestId(`embedded-editor-host-${grandchild.id}`)).toHaveCount(0);
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(100);
    await panel.evaluate((element, scrollTop) => { element.scrollTop = scrollTop; }, childScrollTop);
    await expect(childHost).toBeVisible();

    await expect.poll(() => childWrapper.evaluate(element => element.getBoundingClientRect().height), { timeout: 3000 })
        .toBeLessThan(expandedHeight - 300);
    const collapsed = await childWrapper.evaluate(element => {
        const mount = element.querySelector<HTMLElement>(':scope > .cm-embedded-react-mount');
        return {
            wrapper: element.getBoundingClientRect().height,
            mount: mount?.getBoundingClientRect().height || 0
        };
    });
    expect(Math.abs(collapsed.wrapper - collapsed.mount)).toBeLessThanOrEqual(10);
});

test('scrolls only wide rendered display math', async ({ page }) => {
    const editor = await openEditor(page);
    await page.setViewportSize({ width: 800, height: 700 });
    const wideFormula = Array(45).fill('x^2').join('+');
    const tallFormula = String.raw`\frac{\displaystyle\sum_{i=1}^{n}\frac{a_i}{1+b_i^2}}{\displaystyle\int_0^1 x^2\,dx}`;
    await replaceEditorText(page, editor, `\\[x^2\\]\n\\[${wideFormula}\\]\n\\[${tallFormula}\\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');

    const rendered = page.locator('.cm-math-rendered');
    await expect(rendered).toHaveCount(3);
    const short = await rendered.nth(0).evaluate(element => ({
        client: element.clientWidth,
        scroll: element.scrollWidth
    }));
    const wide = await rendered.nth(1).evaluate(element => {
        const before = { client: element.clientWidth, scroll: element.scrollWidth };
        element.scrollLeft = element.scrollWidth;
        return { ...before, position: element.scrollLeft };
    });
    expect(short.scroll).toBeLessThanOrEqual(short.client + 1);
    expect(wide.scroll).toBeGreaterThan(wide.client + 20);
    expect(wide.position).toBeGreaterThan(0);
    const verticalOverflow = await rendered.evaluateAll(elements => elements.map(element => ({
        client: element.clientHeight,
        scroll: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY
    })));
    // KaTeX ink can round 1–2 CSS pixels beyond the fractional layout box;
    // that is not a vertical scrollbar when the axis remains hidden.
    expect(verticalOverflow.every(item => item.scroll <= item.client + 4)).toBe(true);
    expect(verticalOverflow.every(item => item.overflowY === 'hidden')).toBe(true);
    await rendered.nth(1).evaluate(element => { element.scrollLeft = 0; });
    await rendered.nth(1).hover();
    await page.mouse.wheel(250, 0);
    await expect.poll(() => rendered.nth(1).evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

test('recognizes math typed into an initially empty display block', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '\\[\n\n\\]');
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.insertText('\\frac');
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.insertText('{1}{2}');
    await expect(page.locator('.cm-math-block .katex .mfrac')).toBeVisible();
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-block .katex .mfrac')).toBeVisible();
});

test('reuses inline preview DOM while typing and moving the cursor', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '$x$');
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    const preview = page.locator('.cm-math-preview');
    await expect(preview.locator('.katex')).toBeVisible();
    await expect(preview).toHaveClass(/cm-tooltip/);
    const initialBackground = await preview.evaluate(dom => getComputedStyle(dom).backgroundColor);
    await preview.evaluate(dom => { (window as any).__mathPreview = dom; });
    await page.keyboard.insertText('y');
    await expect(preview.locator('annotation')).toHaveText('yx');
    await expect(preview).toHaveClass(/cm-tooltip/);
    expect(await preview.evaluate(dom => getComputedStyle(dom).backgroundColor)).toBe(initialBackground);
    await page.keyboard.press('ArrowRight');
    expect(await preview.evaluate(dom => dom === (window as any).__mathPreview)).toBe(true);
    await page.keyboard.insertText('^2');
    await expect(preview.locator('annotation')).toHaveText('yx^2');
    await page.getByLabel('Open settings').click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator('.cm-math-inline .katex')).toBeVisible();
});

test('inserts one prime per apostrophe keystroke inside inline math', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '$f$');
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await page.keyboard.press("'");
    await expect(editor).toContainText("$f'$");
    await page.keyboard.press("'");
    await expect(editor).toContainText("$f''$");
    await page.keyboard.press("'");
    await expect(editor).toContainText("$f'''$");

    await replaceEditorText(page, editor, '');
    await page.keyboard.press("'");
    await expect(editor).toContainText("''");
});

test('changes empty-set appearance without rewriting the LaTeX source', async ({ page, request }) => {
    // Test mode otherwise inherits the user's workspace preference.
    expect((await request.post('/api/settings', { data: { emptySetStyle: 'standard' } })).ok()).toBeTruthy();
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, String.raw`Inline $\emptyset$ and display \[\emptyset\]`);
    await page.getByLabel('Open settings').click();
    await page.keyboard.press('Escape');

    await expect(page.locator('.cm-math-inline')).toBeVisible();
    await expect(page.locator('.cm-math-block')).toBeVisible();
    await expect(page.locator('.cm-math-inline .amsrm, .cm-math-block .amsrm')).toHaveCount(0);

    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    const style = page.getByLabel('Empty Set Appearance');
    await expect(style).toHaveValue('standard');
    await style.selectOption('slanted');
    await page.getByRole('button', { name: 'Save Settings' }).click();

    await expect(page.locator('.cm-math-inline .amsrm')).toBeVisible();
    await expect(page.locator('.cm-math-block .amsrm')).toBeVisible();
    await page.locator('.cm-math-inline').click();
    await expect(editor).toContainText(String.raw`\emptyset`);

    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.emptySetStyle).toBe('slanted');
});

test('updates display previews in place and preserves surrounding formulas', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '$a$\n\\[\nx\n\\]\n$b$');
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    const preview = page.locator('.cm-math-block');
    await expect(preview.locator('.katex')).toBeVisible();
    await preview.evaluate(dom => { (window as any).__blockPreview = dom; });
    await page.keyboard.insertText('^2');
    await expect(preview.locator('annotation')).toHaveText('x^2');
    expect(await preview.evaluate(dom => dom === (window as any).__blockPreview)).toBe(true);
    await page.getByLabel('Open settings').click();
    await expect(page.locator('.cm-math-inline .katex')).toHaveCount(2);
    await expect(preview.locator('annotation')).toHaveText('x^2');
});

test('indents selected display-math lines with Tab and outdents with Shift+Tab', async ({ page }) => {
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '\\[\nfirst\nsecond\n\\]');

    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Tab');

    await expect.poll(() => editor.evaluate(element => element.textContent)).toContain('  first  second');

    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => editor.evaluate(element => element.textContent)).toContain('firstsecond');
});
