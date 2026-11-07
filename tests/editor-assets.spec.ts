import { expect, test } from 'playwright/test';
import path from 'node:path';
import { openEditor, replaceEditorText } from './helpers/editor';

test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/test/reset');
    expect(response.ok()).toBeTruthy();
});

test('renders image previews as their lines enter the viewport', async ({ page }) => {
    test.setTimeout(60_000);
    const editor = await openEditor(page);
    const image = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="1"/>';
    const content = Array.from({ length: 180 }, (_, index) => `${index} ${index === 0 || index === 179 ? image : 'plain text'}`).join('\n');
    await replaceEditorText(page, editor, content);

    await page.keyboard.press('ControlOrMeta+Home');
    const images = page.locator('.cm-image-widget');
    await expect(images).toHaveCount(2);
    await expect(images.first()).toBeVisible();
    await page.locator('.cm-scroller').evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
    });
    await expect(images.last()).toBeVisible();
});

test('stores portable image paths and renders portable and legacy asset references', async ({ page }) => {
    const assetName = `test-image-${Date.now()}.gif`;
    const upload = await page.request.post('/api/assets', {
        data: {
            filePath: `assets/${assetName}`,
            content: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        }
    });
    expect(upload.ok()).toBeTruthy();
    expect(await upload.json()).toMatchObject({ url: `assets/${assetName}` });

    const editor = await openEditor(page);
    await replaceEditorText(page, editor, [
        `<img src="assets/${assetName}" width="1"/>`,
        `<img src="/api/assets/${assetName}" width="1"/>`,
        'after images'
    ].join('\n'));
    await editor.evaluate(element => (element as HTMLElement).blur());

    const images = page.locator('.cm-image-widget img');
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll(elements => elements.map(element => (element as HTMLImageElement).naturalWidth)))
        .toEqual([1, 1]);
});

test('renders an HTML image reference whose asset filename contains spaces', async ({ page }) => {
    const assetName = `test image ${Date.now()}.gif`;
    const upload = await page.request.post('/api/assets', {
        data: {
            filePath: `assets/${assetName}`,
            content: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        }
    });
    expect(upload.ok()).toBeTruthy();
    expect(await upload.json()).toMatchObject({ url: `assets/${assetName}` });

    const editor = await openEditor(page);
    await replaceEditorText(page, editor, `<img src="assets/${assetName}" width="1" />\nafter image`);
    await editor.evaluate(element => (element as HTMLElement).blur());
    const image = page.locator('.cm-image-widget img');
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
});

test('reserves image geometry before loading and keeps its height after decoding', async ({ page }) => {
    const editor = await openEditor(page);
    let releaseImage!: () => void;
    const pending = new Promise<void>(resolve => { releaseImage = resolve; });
    await page.route('**/api/assets/slow-geometry.gif*', async route => {
        await pending;
        await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') });
    });
    await replaceEditorText(page, editor,
        '<img src="assets/slow-geometry.gif" width="200" data-natural-width="1" data-natural-height="1" />\nafter image');
    await editor.evaluate(element => (element as HTMLElement).blur());
    const image = page.locator('.cm-image-widget img');
    await expect(image).toHaveAttribute('data-image-reserved', 'true');
    const before = await image.evaluate(element => element.getBoundingClientRect().height);
    expect(before).toBeGreaterThanOrEqual(199);
    expect(before).toBeLessThanOrEqual(201);
    releaseImage();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const after = await image.evaluate(element => element.getBoundingClientRect().height);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});

test('reserves percentage-width image geometry responsively', async ({ page }) => {
    const editor = await openEditor(page);
    let releaseImage!: () => void;
    const pending = new Promise<void>(resolve => { releaseImage = resolve; });
    await page.route('**/api/assets/percent-geometry.gif*', async route => {
        await pending;
        await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') });
    });
    await replaceEditorText(page, editor,
        '<img src="assets/percent-geometry.gif" width="50%" data-natural-width="1" data-natural-height="1" />\nafter image');
    await editor.evaluate(element => (element as HTMLElement).blur());
    const image = page.locator('.cm-image-widget img');
    await expect(image).toHaveAttribute('data-image-reserved', 'true');
    const measure = () => image.evaluate(element => {
        const line = element.closest('.cm-line')!;
        return { width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height, lineWidth: line.getBoundingClientRect().width };
    });
    const before = await measure();
    expect(before.width / before.lineWidth).toBeGreaterThan(0.45);
    expect(before.width / before.lineWidth).toBeLessThan(0.55);
    expect(Math.abs(before.height - before.width)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 900, height: 720 });
    const resized = await measure();
    expect(resized.width).toBeLessThan(before.width);
    expect(Math.abs(resized.height - resized.width)).toBeLessThanOrEqual(1);
    releaseImage();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const loaded = await measure();
    expect(Math.abs(loaded.height - resized.height)).toBeLessThanOrEqual(1);
});

test('caps a tall reservation and corrects stale image dimensions after load', async ({ page }) => {
    const editor = await openEditor(page);
    let releaseImage!: () => void;
    const pending = new Promise<void>(resolve => { releaseImage = resolve; });
    await page.route('**/api/assets/stale-geometry.gif*', async route => {
        await pending;
        await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') });
    });
    await replaceEditorText(page, editor,
        '<img src="assets/stale-geometry.gif" width="500" data-natural-width="1" data-natural-height="100" />\nafter image');
    await editor.evaluate(element => (element as HTMLElement).blur());
    const image = page.locator('.cm-image-widget img');
    await expect(image).toHaveAttribute('data-image-reserved', 'true');
    expect(await image.evaluate(element => element.getBoundingClientRect().height)).toBe(600);
    releaseImage();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().height)).toBe(500);
});

test('resolves repeated image assets once while their widgets are mounted', async ({ page }) => {
    const editor = await openEditor(page);
    await page.evaluate(async () => {
        const moduleUrl = '/src/store/index.ts';
        const { useStore } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../src/store');
        const original = useStore.getState().getAssetUrl;
        (window as Window & { imageLookups?: number }).imageLookups = 0;
        useStore.setState({ getAssetUrl: async path => {
            (window as Window & { imageLookups?: number }).imageLookups! += 1;
            return original(path);
        } });
    });
    await replaceEditorText(page, editor,
        '<img src="assets/shared-image.gif" width="100" data-natural-width="1" data-natural-height="1" />\n' +
        '<img src="assets/shared-image.gif" width="100" data-natural-width="1" data-natural-height="1" />\nafter images');
    await editor.evaluate(element => (element as HTMLElement).blur());
    await expect(page.locator('.cm-image-widget')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => (window as Window & { imageLookups?: number }).imageLookups)).toBe(1);
});

test('keeps a shared asset URL alive until its last image releases it', async ({ page }) => {
    await openEditor(page);
    const outcome = await page.evaluate(async () => {
        const moduleUrl = '/src/lib/editor/image-resources.ts';
        const { acquireImageUrl } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../src/lib/editor/image-resources');
        const url = URL.createObjectURL(new Blob(['shared']));
        let lookups = 0;
        const resolve = async () => { lookups += 1; return url; };
        const first = acquireImageUrl('assets/shared-lease.png', 1, resolve);
        const second = acquireImageUrl('assets/shared-lease.png', 1, resolve);
        const urls = await Promise.all([first.promise, second.promise]);
        first.release();
        const aliveAfterFirst = (await fetch(url)).ok;
        second.release();
        let aliveAfterLast = true;
        try { await fetch(url); } catch { aliveAfterLast = false; }
        return { lookups, sameUrl: urls[0] === urls[1], aliveAfterFirst, aliveAfterLast };
    });
    expect(outcome).toEqual({ lookups: 1, sameUrl: true, aliveAfterFirst: true, aliveAfterLast: false });
});

test('keeps an open embedded block height steady while a reserved image loads', async ({ page }) => {
    const label = `image-height-child-${Date.now()}`;
    const rootLabel = `image-height-root-${Date.now()}`;
    const child = await (await page.request.post('/api/blocks', { data: {
        title: 'Image height child', label,
        content: 'before image\n<img src="assets/embedded-slow.gif" width="240" data-natural-width="1" data-natural-height="1" />\nafter image'
    } })).json();
    await page.request.post('/api/blocks', { data: { title: 'Image height root', label: rootLabel, content: `[[${label}∨]]\nfollowing row` } });
    let releaseImage!: () => void;
    const pending = new Promise<void>(resolve => { releaseImage = resolve; });
    await page.route('**/api/assets/embedded-slow.gif*', async route => {
        await pending;
        await route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') });
    });
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    const host = page.getByTestId(`embedded-editor-host-${child.id}`);
    const image = host.locator('.cm-image-widget img');
    await expect(image).toHaveAttribute('data-image-reserved', 'true');
    const wrapper = host.locator('xpath=ancestor::*[contains(@class,"cm-embedded-block-wrapper")][1]');
    const before = await wrapper.evaluate(element => element.getBoundingClientRect().height);
    expect(before).toBeGreaterThan(240);
    releaseImage();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    await expect.poll(() => wrapper.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(240);
    const after = await wrapper.evaluate(element => element.getBoundingClientRect().height);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(3);
});

test('learns legacy image geometry without editing its source and invalidates it on replacement', async ({ page }) => {
    const filePath = 'assets/legacy-geometry.gif';
    const data = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    expect((await page.request.post('/api/assets', { data: { filePath, content: `data:image/gif;base64,${data}` } })).ok()).toBeTruthy();
    const editor = await openEditor(page);
    const source = `<img src="${filePath}" width="120" />`;
    await replaceEditorText(page, editor, `${source}\nafter image`);
    await editor.evaluate(element => (element as HTMLElement).blur());
    const image = page.locator('.cm-image-widget img');
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const moduleUrl = '/src/lib/editor/image-resources.ts';
    await expect.poll(() => page.evaluate(async (url) => {
        const { knownImageGeometry } = await import(/* @vite-ignore */ url) as typeof import('../src/lib/editor/image-resources');
        return knownImageGeometry('assets/legacy-geometry.gif');
    }, moduleUrl)).toEqual({ width: 1, height: 1 });
    await image.click();
    await expect(editor).toContainText(source);
    await editor.getByText('after image').click();
    await expect(image).toHaveAttribute('data-image-reserved', 'true');

    let releaseImage!: () => void;
    const pending = new Promise<void>(resolve => { releaseImage = resolve; });
    await page.route('**/api/assets/legacy-geometry.gif?v=1', async route => {
        await pending;
        await route.fulfill({ contentType: 'image/gif', body: Buffer.from(data, 'base64') });
    });
    await page.evaluate(async encoded => {
        const moduleUrl = '/src/store/index.ts';
        const { useStore } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../src/store');
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        await useStore.getState().saveAsset(new File([bytes], 'legacy-geometry.gif', { type: 'image/gif' }), 'legacy-geometry.gif', true);
    }, data);
    await expect(image).toHaveAttribute('src', /legacy-geometry\.gif\?v=1$/);
    await expect(image).not.toHaveAttribute('data-image-reserved', 'true');
    releaseImage();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
});

test('a missing image settles an embedded block without retaining its reserved height', async ({ page }) => {
    const label = `image-missing-child-${Date.now()}`;
    const rootLabel = `image-missing-root-${Date.now()}`;
    const child = await (await page.request.post('/api/blocks', { data: {
        title: 'Missing image child', label,
        content: 'before\n<img src="assets/not-found-embedded.gif" width="300" data-natural-width="1" data-natural-height="100" />\nafter'
    } })).json();
    await page.request.post('/api/blocks', { data: { title: 'Missing image root', label: rootLabel, content: `[[${label}∨]]` } });
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const title = panel.locator('[data-embed-nav-title]').filter({ hasText: 'Missing image child' });
    const host = page.getByTestId(`embedded-editor-host-${child.id}`);
    const fallback = host.getByText('Image unavailable: assets/not-found-embedded.gif');
    await expect(fallback).toBeVisible();
    await expect(host.locator('img[data-image-failed="true"]')).toHaveCount(1);
    const gap = () => host.evaluate(element => {
        const wrapper = element.closest('.cm-embedded-block-wrapper')!;
        const mount = wrapper.querySelector(':scope > .cm-embedded-react-mount')!;
        return wrapper.getBoundingClientRect().height - mount.getBoundingClientRect().height;
    });
    await expect.poll(gap).toBeLessThanOrEqual(20);
    await title.click();
    await expect(host).toHaveCount(0);
    await title.click();
    await expect(fallback).toBeVisible();
    await expect.poll(gap).toBeLessThanOrEqual(20);
});

test('renders reordered HTML image attributes and shows a missing-image fallback', async ({ page }) => {
    const assetName = 'reordered attributes.gif';
    const upload = await page.request.post('/api/assets', {
        data: {
            filePath: `assets/${assetName}`,
            content: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        }
    });
    expect(upload.ok()).toBeTruthy();
    const editor = await openEditor(page);
    await replaceEditorText(page, editor,
        `<img width='40' alt='a > b' src='assets/reordered%20attributes.gif' />\n<img src="assets/missing.gif" />\nafter images`);
    const images = page.locator('.cm-image-widget img');
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.first().evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(page.getByText('Image unavailable: assets/missing.gif')).toBeVisible();
});

test('clicking a rendered or unavailable image reveals its source and focuses the caret', async ({ page }) => {
    const editor = await openEditor(page);
    const imageSource = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="1" />';
    const missingSource = '![missing](assets/not-found.gif)';
    await replaceEditorText(page, editor, `${imageSource}\n${missingSource}\nafter images`);
    await editor.evaluate(element => (element as HTMLElement).blur());
    await expect(page.locator('.cm-image-widget')).toHaveCount(2);
    await page.locator('.cm-image-widget img').first().click();
    await expect(editor).toBeFocused();
    await expect(editor).toContainText(imageSource);
    await page.keyboard.insertText('x');
    await expect(editor).toContainText(`<x${imageSource.slice(1)}`);
    await expect(page.locator('.cm-image-widget')).toHaveCount(1);
    await expect(page.getByText('Image unavailable: assets/not-found.gif')).toBeVisible();
    await page.getByText('Image unavailable: assets/not-found.gif').click();
    await expect(editor).toBeFocused();
    await expect(editor).toContainText(missingSource);
    await page.keyboard.insertText('x');
    await expect(editor).toContainText(`!x${missingSource.slice(1)}`);
    await expect(page.locator('.cm-image-widget')).toHaveCount(0);
});

test('refreshes an already rendered image after an explicit replacement', async ({ page }) => {
    const upload = await page.request.post('/api/assets', {
        data: {
            filePath: 'assets/replace-me.gif',
            content: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        }
    });
    expect(upload.ok()).toBeTruthy();
    const editor = await openEditor(page);
    await replaceEditorText(page, editor, '<img src="assets/replace-me.gif" width="100" />\nafter image');
    const image = page.locator('.cm-image-widget img');
    await expect(image).toHaveAttribute('src', /replace-me\.gif\?v=0$/);
    await page.evaluate(async () => {
        const moduleUrl = '/src/store/index.ts';
        const { useStore } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../src/store');
        const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), c => c.charCodeAt(0));
        await useStore.getState().saveAsset(new File([bytes], 'replace-me.gif', { type: 'image/gif' }), 'replace-me.gif', true);
    });
    await expect(image).toHaveAttribute('src', /replace-me\.gif\?v=1$/);
});

test('save-style image picker keeps spaces, browses folders, and inserts existing images', async ({ page }) => {
    const editor = await openEditor(page);
    const openPicker = async () => {
        await page.evaluate(async () => {
            const moduleUrl = '/src/store/index.ts';
            const { useStore } = await import(/* @vite-ignore */ moduleUrl) as typeof import('../src/store');
            const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), c => c.charCodeAt(0));
            const file = new File([bytes], 'my proof image.gif', { type: 'image/gif' });
            useStore.getState().setImageUploadParams({
                file,
                assertInsertable: () => {},
                onInsert: (reference: string) => { (window as Window & { insertedImage?: string }).insertedImage = reference; }
            });
        });
    };

    await openPicker();
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await expect(dialog.getByRole('textbox', { name: 'File name' })).toHaveValue('my proof image.gif');
    await dialog.getByRole('button', { name: 'New folder' }).click();
    await dialog.getByRole('textbox', { name: 'New folder name' }).fill('proof images');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog.getByText('Reference: assets/proof%20images/my%20proof%20image.gif')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save & insert' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { insertedImage?: string }).insertedImage))
        .toBe('<img src="assets/proof%20images/my%20proof%20image.gif" width="500" data-natural-width="1" data-natural-height="1" />');
    const stored = await page.request.get('/api/assets/proof%20images/my%20proof%20image.gif');
    expect(stored.ok()).toBeTruthy();
    await replaceEditorText(page, editor, '<img src="assets/proof%20images/my%20proof%20image.gif" width="500" />\nafter image');
    await expect.poll(() => page.locator('.cm-image-widget img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);

    await openPicker();
    await dialog.getByRole('button', { name: 'proof images' }).click();
    await expect(dialog.getByText('This file exists. Saving will replace it.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Replace & insert' }).click();
    await expect(dialog).toHaveCount(0);

    await openPicker();
    await dialog.getByRole('button', { name: 'Insert existing' }).click();
    await dialog.getByRole('button', { name: 'proof images' }).click();
    await dialog.getByRole('button', { name: 'my proof image.gif' }).click();
    await dialog.getByRole('button', { name: 'Insert image' }).click();
    expect(await page.evaluate(() => (window as Window & { insertedImage?: string }).insertedImage))
        .toBe('<img src="assets/proof%20images/my%20proof%20image.gif" width="500" data-natural-width="1" data-natural-height="1" />');
});

test('manages an image from General Settings with reviewed note references and stale-preview protection', async ({ page, request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    expect((await request.post('/api/assets', { data: { filePath: 'assets/old image.gif', content: gif } })).ok()).toBeTruthy();
    const created = await (await request.post('/api/blocks', { data: {
        title: 'Asset move note', label: 'test:asset-move',
        content: '<img src="assets/old%20image.gif" width="50" alt="keep" />\n![caption](assets/old%20image.gif)'
    } })).json();
    await openEditor(page);
    await page.getByLabel('Open settings').click();
    const dialog = page.getByRole('dialog', { name: 'Editor Settings' });
    await dialog.getByText('Manage Assets', { exact: true }).first().click();
    const manager = dialog.getByRole('region', { name: 'Manage Assets' });
    await manager.getByRole('button', { name: 'old image.gif' }).click();
    await manager.getByLabel('New path inside assets').fill('figures/new image.gif');
    await manager.getByRole('button', { name: 'Review rename / move' }).click();
    const preview = manager.getByTestId('asset-move-preview');
    await expect(preview).toContainText('Asset move note');
    await expect(preview).toContainText('2 image references');
    await expect(preview).toContainText('assets/figures/new%20image.gif');
    await manager.getByLabel('New path inside assets').fill('figures/changed.gif');
    await expect(preview).toHaveCount(0);
    await manager.getByLabel('New path inside assets').fill('figures/new image.gif');
    await manager.getByRole('button', { name: 'Review rename / move' }).click();
    await manager.getByRole('button', { name: 'Confirm move' }).click();
    await expect(manager.getByRole('status')).toContainText('Updated 1 note');
    const stored = await (await request.get(`/api/blocks/${created.id}`)).json();
    expect(stored.content).toBe('<img src="assets/figures/new%20image.gif" width="50" alt="keep" />\n![caption](assets/figures/new%20image.gif)');
    expect((await request.get('/api/assets/figures/new%20image.gif')).ok()).toBeTruthy();
    expect((await request.get('/api/assets/old%20image.gif')).ok()).toBeFalsy();
});

test('clears Manage Assets selection when the workspace changes', async ({ page, request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    expect((await request.post('/api/assets', { data: { filePath: 'assets/previous.gif', content: gif } })).ok()).toBeTruthy();
    await openEditor(page);
    await page.getByLabel('Open settings').click();
    const dialog = page.getByRole('dialog', { name: 'Editor Settings' });
    await dialog.getByText('Manage Assets', { exact: true }).first().click();
    const manager = dialog.getByRole('region', { name: 'Manage Assets' });
    await manager.getByRole('button', { name: 'previous.gif' }).click();
    await expect(manager).toContainText('Selected: assets/previous.gif');
    await page.evaluate(async () => {
        const storeUrl = '/src/store/index.ts';
        const { useStore } = await import(storeUrl) as typeof import('../src/store');
        const transfer = new DataTransfer();
        transfer.items.add(new File(['---\nid: viewer-note\ntitle: Viewer note\nlabel: viewer/note\n---\nContent'], 'Viewer.md', { type: 'text/markdown' }));
        await useStore.getState().loadViewerFiles(transfer.files);
    });
    await expect(manager).toContainText('Connect a writable workspace');
    await expect(manager).not.toContainText('previous.gif');
});

test('rejects an asset move after a note changes following preview', async ({ request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    await request.post('/api/assets', { data: { filePath: 'assets/stale.gif', content: gif } });
    const note = await (await request.post('/api/blocks', { data: {
        title: 'Stale asset note', label: 'test:stale-asset', content: '<img src="assets/stale.gif" />'
    } })).json();
    const preview = await (await request.post('/api/assets/move/preview', { data: { source: 'assets/stale.gif', destination: 'assets/moved.gif' } })).json();
    await request.put(`/api/blocks/${note.id}`, { data: { ...note, content: 'Changed while preview was open' } });
    const result = await request.post('/api/assets/move/commit', { data: preview });
    expect(result.status()).toBe(409);
    expect((await request.get('/api/assets/stale.gif')).ok()).toBeTruthy();
    expect((await request.get('/api/assets/moved.gif')).ok()).toBeFalsy();
});

test('rejects an asset move when the source bytes or destination changes after preview', async ({ request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    await request.post('/api/assets', { data: { filePath: 'assets/source.gif', content: gif } });
    const beforeReplacement = await (await request.post('/api/assets/move/preview', { data: {
        source: 'assets/source.gif', destination: 'assets/first.gif'
    } })).json();
    const alternateGif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    // A destination collision invalidates a plan even if no note changed.
    await request.post('/api/assets', { data: { filePath: 'assets/first.gif', content: alternateGif } });
    expect((await request.post('/api/assets/move/commit', { data: beforeReplacement })).status()).toBe(409);
    const second = await (await request.post('/api/assets/move/preview', { data: {
        source: 'assets/source.gif', destination: 'assets/second.gif'
    } })).json();
    await request.post('/api/assets', { data: { filePath: 'assets/source.gif', content: 'data:image/gif;base64,R0lGODlhAgABAIAAAAAAAP///ywAAAAAAgABAAACAUwAOw==', overwrite: true } });
    expect((await request.post('/api/assets/move/commit', { data: second })).status()).toBe(409);
    expect((await request.get('/api/assets/source.gif')).ok()).toBeTruthy();
});

test('opens image picker without a paste and searches existing assets', async ({ page }) => {
    const assetName = 'proof images/find this image.gif';
    const upload = await page.request.post('/api/assets', {
        data: {
            filePath: `assets/${assetName}`,
            content: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        }
    });
    expect(upload.ok()).toBeTruthy();
    const editor = await openEditor(page);
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await expect(dialog.getByRole('button', { name: 'Insert existing' })).toHaveClass(/bg-accent/);
    await dialog.getByRole('textbox', { name: 'Search assets' }).fill('find this');
    await expect(dialog.getByRole('button', { name: assetName })).toBeVisible();
    await dialog.getByRole('button', { name: assetName }).click();
    await expect(dialog.getByText(`Reference: assets/proof%20images/find%20this%20image.gif`)).toBeVisible();
    await dialog.getByRole('button', { name: 'Insert image', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(editor).toContainText('assets/proof%20images/find%20this%20image.gif');
});

test('inserts images with a customizable shortcut and no toolbar button', async ({ page }) => {
    const editor = await openEditor(page);
    await expect(page.getByRole('button', { name: 'Insert image into active note' })).toHaveCount(0);
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Keyboard Shortcuts' }).click();
    const shortcut = page.getByLabel('Insert image shortcut');
    await expect(shortcut).toHaveValue('mod+i');
    await shortcut.fill('mod+k');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('alert')).toContainText('Keyboard shortcuts must be unique.');
    await shortcut.fill('mod+shift+i');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+i');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Shift+i');
    await expect(dialog).toBeVisible();
});

test('uses Ctrl+I for the default image shortcut on Windows', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' }));
    const editor = await openEditor(page);
    await editor.focus();
    await page.keyboard.press('Control+i');
    await expect(page.getByRole('dialog', { name: 'Insert image' })).toBeVisible();
});

test('image picker replaces the selected text at the original caret', async ({ page, request }) => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    expect((await request.post('/api/assets', { data: { filePath: 'assets/selection.gif', content: gif } })).ok()).toBeTruthy();
    const editor = await openEditor(page);
    await editor.fill('replace this text');
    await editor.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await dialog.getByRole('button', { name: 'selection.gif' }).click();
    await dialog.getByRole('button', { name: 'Insert image', exact: true }).click();
    await expect.poll(() => editor.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        return EditorView.findFromDOM(element.closest('.cm-editor')!).state.doc.toString();
    })).toContain('<img src="assets/selection.gif"');
    expect(await editor.evaluate(element => element.textContent)).not.toContain('replace this text');
});

test('does not save an image after the target note changes while the picker is open', async ({ page, request }) => {
    const editor = await openEditor(page);
    await editor.fill('original text');
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await dialog.getByRole('button', { name: 'Save a copy' }).click();
    await dialog.getByLabel('Image to save').setInputFiles({
        name: 'not-saved.gif', mimeType: 'image/gif',
        buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
    });
    await editor.evaluate(async element => {
        const viewUrl = '/node_modules/.vite/deps/@codemirror_view.js';
        const { EditorView } = await import(viewUrl);
        EditorView.findFromDOM(element.closest('.cm-editor')!).dispatch({ changes: { from: 0, insert: 'changed ' } });
    });
    await dialog.getByRole('button', { name: 'Save & insert' }).click();
    await expect(dialog.getByRole('alert')).toContainText('note changed');
    expect((await request.get('/api/assets/not-saved.gif')).ok()).toBeFalsy();
});

test('chooses and saves a new image from the in-app picker without pasting', async ({ page }) => {
    const editor = await openEditor(page);
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await dialog.getByRole('button', { name: 'Save a copy' }).click();
    await dialog.getByLabel('Image to save').setInputFiles({
        name: 'picked image.gif',
        mimeType: 'image/gif',
        buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
    });
    await expect(dialog.getByRole('textbox', { name: 'File name' })).toHaveValue('picked image.gif');
    await dialog.getByRole('button', { name: 'Save & insert' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(editor).toContainText('assets/picked%20image.gif');
    expect((await page.request.get('/api/assets/picked%20image.gif')).ok()).toBeTruthy();
});

test('pauses image saving when the asset list fails and resumes after retry', async ({ page }) => {
    const editor = await openEditor(page);
    await editor.focus();
    await page.route('**/api/assets-list', route => route.fulfill({ status: 500, body: 'unavailable' }));
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await dialog.getByRole('button', { name: 'Save a copy' }).click();
    await dialog.getByLabel('Image to save').setInputFiles({
        name: 'retry image.gif',
        mimeType: 'image/gif',
        buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
    });
    await expect(dialog.getByText('Could not list assets. Saving is paused to protect existing files.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save & insert' })).toBeDisabled();
    await page.unroute('**/api/assets-list');
    await dialog.getByRole('button', { name: 'Retry' }).click();
    await expect(dialog.getByRole('button', { name: 'Save & insert' })).toBeEnabled();
});

test('inserts an existing image into the focused embedded editor', async ({ page }) => {
    const image = await page.request.post('/api/assets', {
        data: {
            filePath: 'assets/inside-child.gif',
            content: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        }
    });
    expect(image.ok()).toBeTruthy();
    const childLabel = `image-child-${Date.now()}`;
    const rootLabel = `image-root-${Date.now()}`;
    const child = await (await page.request.post('/api/blocks', { data: { title: 'Image child', label: childLabel, content: 'child row' } })).json();
    const root = await (await page.request.post('/api/blocks', { data: { title: 'Image root', label: rootLabel, content: `[[${childLabel}∨]]` } })).json();
    await openEditor(page);
    await page.getByRole('button', { name: /Search/ }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');
    const editors = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content');
    const childEditor = editors.nth(1);
    await childEditor.focus();
    await expect(childEditor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+i');
    const dialog = page.getByRole('dialog', { name: 'Insert image' });
    await dialog.getByRole('button', { name: 'inside-child.gif' }).click();
    await dialog.getByRole('button', { name: 'Insert image', exact: true }).click();
    await expect(childEditor).toContainText('assets/inside-child.gif');
    await page.locator('[role="tabpanel"][aria-hidden="false"] [data-testid^="block-metadata-header-"]').click();
    await expect.poll(async () => (await (await page.request.get(`/api/blocks/${child.id}/raw`)).text())).toContain('assets/inside-child.gif');
    expect(await (await page.request.get(`/api/blocks/${root.id}/raw`)).text()).not.toContain('assets/inside-child.gif');
});

test('rejects asset uploads outside the workspace assets directory', async ({ request }) => {
    const content = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    for (const filePath of ['assets/../outside.gif', 'assets-elsewhere/outside.gif', '../assets/outside.gif']) {
        const response = await request.post('/api/assets', { data: { filePath, content } });
        expect(response.status(), filePath).toBe(400);
    }
    const invalidContent = await request.post('/api/assets', {
        data: { filePath: 'assets/not-an-image.gif', content: 'not a data URI' }
    });
    expect(invalidContent.status()).toBe(400);
});

test('rejects stale image overwrites and disguised non-images at the server', async ({ request }) => {
    const path = 'assets/conflicts/same image.gif';
    const content = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    const first = await request.post('/api/assets', { data: { filePath: path, content, overwrite: false } });
    expect(first.ok()).toBeTruthy();
    const stale = await request.post('/api/assets', { data: { filePath: path, content, overwrite: false } });
    expect(stale.status()).toBe(409);
    const concurrentPath = 'assets/conflicts/concurrent.gif';
    const concurrent = await Promise.all([0, 1].map(() => request.post('/api/assets', {
        data: { filePath: concurrentPath, content, overwrite: false }
    })));
    expect(concurrent.map(response => response.status()).sort()).toEqual([200, 409]);
    const explicitReplace = await request.post('/api/assets', { data: { filePath: path, content, overwrite: true } });
    expect(explicitReplace.ok()).toBeTruthy();
    const spoofed = await request.post('/api/assets', {
        data: { filePath: 'assets/not-an-image.gif', content: 'data:image/gif;base64,PHN2Zz48L3N2Zz4=' }
    });
    expect(spoofed.status()).toBe(400);
    const svg = await request.post('/api/assets', {
        data: { filePath: 'assets/vector.svg', content: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }
    });
    expect(svg.status()).toBe(400);
    const wrongExtension = await request.post('/api/assets', {
        data: { filePath: 'assets/wrong.png', content }
    });
    expect(wrongExtension.status()).toBe(400);
});

test('renders workspace assets in the web read-only viewer', async ({ page }) => {
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Read-Only Viewer' })).toBeVisible();

    await page.locator('input[type="file"][webkitdirectory]').setInputFiles(
        path.resolve('tests/fixtures/viewer-workspace')
    );

    await expect(page.getByText('Viewer image test', { exact: true }).first()).toBeVisible();
    const images = page.locator('.cm-image-widget img');
    await expect(images).toHaveCount(2);
    await expect.poll(() => images.evaluateAll(elements => elements.map(element => (element as HTMLImageElement).naturalWidth)))
        .toEqual([2, 2]);
});

test('unlocks read-only viewer notes as resettable in-memory drafts', async ({ page }) => {
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.goto('/');
    await page.locator('input[type="file"][webkitdirectory]').setInputFiles(
        path.resolve('tests/fixtures/viewer-workspace')
    );

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const header = panel.locator('[data-testid="block-metadata-header-viewer-image-test"]');
    const editor = panel.locator('.cm-content').first();
    await header.click();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await page.getByTitle('Unlock for editing').click();
    await expect(page.getByTestId('viewer-draft-banner')).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'true');

    await editor.fill('Temporary viewer draft');
    await expect(page.getByTestId('viewer-draft-banner').getByRole('button', { name: 'Reset preview changes' })).toBeVisible();
    await header.click();
    await page.getByTitle('Lock for view-only').click();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(editor).toContainText('Temporary viewer draft');
    await header.click();
    await page.getByTitle('Unlock for editing').click();
    await page.getByTestId('viewer-draft-banner').getByRole('button', { name: 'Reset preview changes' }).click();
    await expect(editor).toContainText('Viewer images:');
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('locks an entire tab while keeping math, images, and transient embeds rendered', async ({ page, request }) => {
    const suffix = Date.now();
    const childLabel = `test:locked-child-${suffix}`;
    const rootLabel = `test:locked-root-${suffix}`;
    const child = await (await request.post('/api/blocks', { data: {
        title: 'Locked child', label: childLabel, content: 'Nested locked text'
    } })).json();
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    expect((await request.post('/api/assets', { data: { filePath: 'assets/locked-test.gif', content: gif } })).ok()).toBeTruthy();
    const source = `Before $x^2$\n\n\\[\ny=x+1\n\\]\n\n<img src="assets/locked-test.gif" />\n\n[[${childLabel}]]`;
    const root = await (await request.post('/api/blocks', { data: {
        title: 'Locked root', label: rootLabel, content: source
    } })).json();

    await openEditor(page);
    await page.getByRole('button', { name: 'Search' }).click();
    const search = page.getByPlaceholder('Search blocks or create new...');
    await search.fill(rootLabel);
    await search.press('Enter');

    const panel = page.locator('[role="tabpanel"][aria-hidden="false"]');
    const header = panel.locator(`[data-testid="block-metadata-header-${root.id}"]`);
    const rootEditor = panel.locator('.cm-editor').first();
    const rootContent = rootEditor.locator(':scope > .cm-scroller > .cm-content');
    await header.click();
    await page.getByTitle('Lock for view-only').click();
    await expect(rootContent).toHaveAttribute('contenteditable', 'false');
    await expect(rootEditor.locator('.cm-math-inline')).toBeVisible();
    await rootEditor.locator('.cm-math-inline').click();
    await expect(rootEditor.locator('.cm-math-editing')).toHaveCount(0);
    await expect(rootEditor.locator('.cm-math-block.cm-math-rendered')).toBeVisible();
    await rootEditor.locator('.cm-math-block.cm-math-rendered').click();
    await expect(rootEditor.locator('.cm-math-block.cm-math-rendered')).toBeVisible();
    await expect(rootEditor.locator('.cm-math-editing')).toHaveCount(0);
    await rootEditor.locator('.cm-image-widget').click();
    await expect(rootEditor.locator('.cm-image-widget')).toBeVisible();
    await expect(rootContent).not.toBeFocused();

    await rootEditor.getByText('Locked child', { exact: true }).click();
    const childHost = page.getByTestId(`embedded-editor-host-${child.id}`);
    await expect(childHost).toContainText('Nested locked text');
    await expect(childHost.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    expect(await (await request.get(`/api/blocks/${root.id}/raw`)).text()).toBe(source);

    const childTitle = rootEditor.getByRole('button', { name: 'Locked child', exact: true });
    await childTitle.click();
    await expect(childHost).toHaveCount(0);
    await childTitle.focus();
    await childTitle.press('Enter');
    await expect(childHost).toContainText('Nested locked text');
    expect(await (await request.get(`/api/blocks/${root.id}/raw`)).text()).toBe(source);

    await header.dblclick();
    await expect(page.getByLabel('Block title')).toHaveCount(0);
    await expect(page.getByTitle('Delete Block')).toHaveCount(0);
});

test('keeps a root-tab lock from leaking into the same note embedded elsewhere', async ({ page, request }) => {
    const suffix = Date.now();
    const childLabel = `test:isolated-lock-child-${suffix}`;
    const rootLabel = `test:isolated-lock-root-${suffix}`;
    const child = await (await request.post('/api/blocks', { data: {
        title: 'Separately locked child', label: childLabel, content: 'Editable through the parent tab'
    } })).json();
    const root = await (await request.post('/api/blocks', { data: {
        title: 'Unlocked parent', label: rootLabel, content: `[[${childLabel}∨]]`
    } })).json();

    await openEditor(page);
    const openByLabel = async (label: string) => {
        await page.getByRole('button', { name: 'Search' }).click();
        const search = page.getByPlaceholder('Search blocks or create new...');
        await search.fill(label);
        await search.press('Enter');
    };
    await openByLabel(childLabel);
    const childPanel = page.locator(`[role="tabpanel"]#block-tab-panel-${child.id}`);
    await childPanel.locator(`[data-testid="block-metadata-header-${child.id}"]`).click();
    await page.getByTitle('Lock for view-only').click();
    await expect(childPanel.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false');

    await openByLabel(rootLabel);
    const rootPanel = page.locator(`[role="tabpanel"]#block-tab-panel-${root.id}`);
    const embeddedHost = rootPanel.getByTestId(`embedded-editor-host-${child.id}`);
    await expect(embeddedHost).toContainText('Editable through the parent tab');
    await expect(embeddedHost.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');

    await page.getByRole('tab', { name: 'Separately locked child' }).click();
    await expect(childPanel.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false');
});
