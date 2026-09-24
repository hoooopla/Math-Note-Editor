import { expect, test, type Page, type Route } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const note = `---\nid: drive-note\ntitle: Drive Note\nlabel: cloud/note\n---\nOriginal Drive content`;

async function installGoogleDriveMock(page: Page, nestedSettings?: string) {
    let patched = 0;
    let remoteVersion = '1';
    let settingsText: string | null = nestedSettings ?? null;
    let settingsVersion = nestedSettings ? 1 : 0;
    const settingsName = nestedSettings ? 'settings.json' : '.math-note-settings.json';
    const uploadedSettings = (body: string | null) => {
        const match = body?.match(/Content-Type: application\/json; charset=UTF-8\r\n\r\n([\s\S]*?)\r\n--math-note-/g);
        const last = match?.at(-1)?.match(/\r\n\r\n([\s\S]*?)\r\n--math-note-/);
        return last?.[1] || '{}';
    };
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.google={accounts:{oauth2:{initTokenClient:(options)=>({callback:options.callback,requestAccessToken(){window.__driveRequestHadUserActivation=navigator.userActivation.isActive;this.callback({access_token:'test-token',expires_in:3600})}}),revoke:(_,done)=>done()}},picker:{ViewId:{FOLDERS:'folders'},DocsViewMode:{LIST:'list'},Action:{PICKED:'picked',CANCEL:'cancel'},DocsView:class{setIncludeFolders(){return this}setSelectFolderEnabled(){return this}setMode(){return this}},PickerBuilder:class{setAppId(){return this}setDeveloperKey(){return this}setOAuthToken(){return this}addView(){return this}setCallback(callback){this.callback=callback;return this}build(){return{setVisible:()=>this.callback({action:'picked',docs:[{id:'folder-1',name:'Shared Math Notes'}]})}}}}};`
    }));
    await page.route('https://apis.google.com/js/api.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.gapi={load:(_,options)=>options.callback()};`
    }));
    await page.route('https://www.googleapis.com/**', async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/drive/v3/files' && request.method() === 'GET') {
            const settingFolderQuery = url.searchParams.get('q')?.includes("'setting-folder' in parents");
            return route.fulfill({ json: { files: [
                ...(!settingFolderQuery ? [{ id: 'file-1', name: 'Drive Note.md', mimeType: 'text/markdown', version: '1' }] : []),
                ...(nestedSettings && !settingFolderQuery ? [{ id: 'setting-folder', name: 'setting', mimeType: 'application/vnd.google-apps.folder' }] : []),
                ...(settingsText && Boolean(settingFolderQuery) === Boolean(nestedSettings) ? [{ id: 'settings-1', name: settingsName, mimeType: 'application/json', version: String(settingsVersion) }] : [])
            ] } });
        }
        if (url.pathname === '/drive/v3/files/file-1' && url.searchParams.get('alt') === 'media') {
            return route.fulfill({ contentType: 'text/plain', body: note });
        }
        if (url.pathname === '/drive/v3/files/file-1') {
            return route.fulfill({ json: { id: 'file-1', name: 'Drive Note.md', version: remoteVersion } });
        }
        if (url.pathname === '/drive/v3/files/settings-1' && url.searchParams.get('alt') === 'media') {
            return route.fulfill({ contentType: 'application/json', body: settingsText || '{}' });
        }
        if (url.pathname === '/drive/v3/files/settings-1') {
            return route.fulfill({ json: { id: 'settings-1', name: settingsName, version: String(settingsVersion) } });
        }
        if (url.pathname === '/upload/drive/v3/files/file-1' && request.method() === 'PATCH') {
            patched += 1;
            return route.fulfill({ json: { id: 'file-1', name: 'Drive Note.md', version: String(patched + 1) } });
        }
        if (url.pathname === '/upload/drive/v3/files' && request.method() === 'POST') {
            settingsText = uploadedSettings(request.postData());
            settingsVersion += 1;
            return route.fulfill({ json: { id: 'settings-1', name: settingsName, version: '1' } });
        }
        if (url.pathname === '/upload/drive/v3/files/settings-1' && request.method() === 'PATCH') {
            settingsText = uploadedSettings(request.postData());
            settingsVersion += 1;
            return route.fulfill({ json: { id: 'settings-1', name: settingsName, version: String(settingsVersion) } });
        }
        return route.fulfill({ status: 404, body: 'Unexpected mocked Drive request' });
    });
    return { patched: () => patched, settings: () => settingsText, setRemoteVersion: (value: string) => { remoteVersion = value; } };
}

test('signs in, picks a folder, loads a note, and saves edits to Drive', async ({ page }) => {
    const drive = await installGoogleDriveMock(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Choose Google Drive Folder' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose Google Drive Folder' }).click();
    expect(await page.evaluate(() => (window as any).__driveRequestHadUserActivation)).toBe(true);

    await expect(page.getByText('Shared Math Notes')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Drive Note/ })).toBeVisible();
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toContainText('Original Drive content');
    await editor.fill('Edited in the browser');
    await editor.blur();
    await expect.poll(drive.patched).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Disconnect Google Drive' }).click();
    await expect(page.getByRole('button', { name: 'Choose Google Drive Folder' })).toBeVisible();
});

test('reports a blocked Google sign-in popup', async ({ page }) => {
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.google={accounts:{oauth2:{initTokenClient:(options)=>({requestAccessToken(){options.error_callback({type:'popup_failed_to_open'})}})}}};`
    }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Choose Google Drive Folder' }).click();
    await expect(page.getByRole('alert')).toContainText('Google sign-in popup was blocked');
});

test('stops instead of overwriting a newer Drive file', async ({ page }) => {
    const drive = await installGoogleDriveMock(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Choose Google Drive Folder' }).click();
    const editor = page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').first();
    await expect(editor).toContainText('Original Drive content');

    drive.setRemoteVersion('2');
    await editor.fill('This must not overwrite the remote edit');
    await editor.blur();

    await expect(page.getByRole('alert')).toContainText('changed in Google Drive');
    expect(drive.patched()).toBe(0);
});

test('shows the Drive folder and imports local preferences without importing tabs', async ({ page }) => {
    const drive = await installGoogleDriveMock(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Choose Google Drive Folder' }).click();
    await page.getByLabel('Open settings').click();
    await expect(page.getByLabel('Current workspace')).toHaveText('Google Drive · Shared Math Notes');
    await page.locator('input[accept=".json,application/json"]').setInputFiles({
        name: 'settings.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ macros: { '\\Z': '\\mathbb{Z}' }, customCommands: ['\\Z'], textCommands: [], workspaceSession: { openTabs: ['other-note'], activeTab: 'other-note' } }))
    });
    await expect(page.getByRole('status')).toContainText('Settings imported into this Google Drive folder');
    await expect.poll(() => drive.settings()).toContain('\\\\Z');
    expect(JSON.parse(drive.settings() || '{}').workspaceSession.openTabs).not.toContain('other-note');
    await page.getByLabel('Close settings').click();
    await page.getByRole('button', { name: 'Disconnect Google Drive' }).click();
    await page.getByRole('button', { name: 'Choose Google Drive Folder' }).click();
    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Math Macros' }).click();
    await expect(page.getByLabel('Macro 1 name')).toHaveValue('\\Z');
});

test('reports when the browser cannot open a writable local folder', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }); });
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Open Local Folder' }).first().click();
    await expect(page.getByRole('alert')).toContainText('cannot open a writable local folder');
});

test('loads and saves settings from a Drive workspace setting folder', async ({ page }, testInfo) => {
    const drive = await installGoogleDriveMock(page, JSON.stringify({
        macros: { '\\Q': '\\mathbb{Q}' }, customCommands: [], textCommands: []
    }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Choose Google Drive Folder' }).click();
    await page.getByLabel('Open settings').click();
    await page.getByRole('tab', { name: 'Math Macros' }).click();
    await expect(page.getByLabel('Macro 1 name')).toHaveValue('\\Q');
    await page.getByLabel('Macro 1 replacement').fill('\\mathbf{Q}');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect.poll(() => drive.settings()).toContain('\\\\mathbf{Q}');
    await expect(page.getByRole('button', { name: 'Read-Only Viewer' })).toBeVisible();
    const viewerFolder = testInfo.outputPath('viewer-folder');
    await mkdir(viewerFolder, { recursive: true });
    await writeFile(`${viewerFolder}/Other.md`, '---\nid: other\ntitle: Other\nlabel: other\n---\nRead only');
    await page.locator('input[webkitdirectory]').first().setInputFiles(viewerFolder);
    await page.getByLabel('Open settings').click();
    await expect(page.getByLabel('Current workspace')).toContainText('Read-only folder');
});
