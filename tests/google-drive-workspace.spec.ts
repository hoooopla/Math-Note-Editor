import { expect, test, type Page, type Route } from 'playwright/test';

const note = `---\nid: drive-note\ntitle: Drive Note\nlabel: cloud/note\n---\nOriginal Drive content`;

async function installGoogleDriveMock(page: Page) {
    let patched = 0;
    let remoteVersion = '1';
    await page.route('**/api/blocks?metaOnly=true', route => route.abort());
    await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.google={accounts:{oauth2:{initTokenClient:(options)=>({callback:options.callback,requestAccessToken(){this.callback({access_token:'test-token',expires_in:3600})}}),revoke:(_,done)=>done()}},picker:{ViewId:{FOLDERS:'folders'},DocsViewMode:{LIST:'list'},Action:{PICKED:'picked',CANCEL:'cancel'},DocsView:class{setIncludeFolders(){return this}setSelectFolderEnabled(){return this}setMode(){return this}},PickerBuilder:class{setAppId(){return this}setDeveloperKey(){return this}setOAuthToken(){return this}addView(){return this}setCallback(callback){this.callback=callback;return this}build(){return{setVisible:()=>this.callback({action:'picked',docs:[{id:'folder-1',name:'Shared Math Notes'}]})}}}}};`
    }));
    await page.route('https://apis.google.com/js/api.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `window.gapi={load:(_,options)=>options.callback()};`
    }));
    await page.route('https://www.googleapis.com/**', async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/drive/v3/files' && request.method() === 'GET') {
            return route.fulfill({ json: { files: [{ id: 'file-1', name: 'Drive Note.md', mimeType: 'text/markdown', version: '1' }] } });
        }
        if (url.pathname === '/drive/v3/files/file-1' && url.searchParams.get('alt') === 'media') {
            return route.fulfill({ contentType: 'text/plain', body: note });
        }
        if (url.pathname === '/drive/v3/files/file-1') {
            return route.fulfill({ json: { id: 'file-1', name: 'Drive Note.md', version: remoteVersion } });
        }
        if (url.pathname === '/upload/drive/v3/files/file-1' && request.method() === 'PATCH') {
            patched += 1;
            return route.fulfill({ json: { id: 'file-1', name: 'Drive Note.md', version: String(patched + 1) } });
        }
        if (url.pathname === '/upload/drive/v3/files' && request.method() === 'POST') {
            return route.fulfill({ json: { id: 'settings-1', name: '.math-note-settings.json', version: '1' } });
        }
        return route.fulfill({ status: 404, body: 'Unexpected mocked Drive request' });
    });
    return { patched: () => patched, setRemoteVersion: (value: string) => { remoteVersion = value; } };
}

test('signs in, picks a folder, loads a note, and saves edits to Drive', async ({ page }) => {
    const drive = await installGoogleDriveMock(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Choose Google Drive Folder' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose Google Drive Folder' }).click();

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
