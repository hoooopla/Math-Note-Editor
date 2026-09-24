import { v4 as uuidv4 } from 'uuid';
import type { BlockData } from '../store';
import { computeReferences, metadataText, parseFrontmatter, stringifyFrontmatter } from './block-metadata';
import { makeBlockFilename, normalizeBlockLabel, normalizeBlockTitle } from './label-policy';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SETTINGS_NAME = '.math-note-settings.json';
const MAX_MULTIPART_UPLOAD_BYTES = 5 * 1024 * 1024;

type DriveFile = { id: string; name: string; mimeType?: string; modifiedTime?: string; version?: string };
type TokenResponse = { access_token?: string; error?: string; error_description?: string; expires_in?: number };

let accessToken = '';
let folder: { id: string; name: string } | null = null;
let signInScriptPromise: Promise<void> | null = null;
let pickerScriptPromise: Promise<void> | null = null;
const fileByBlockId = new Map<string, DriveFile>();

const config = () => ({
    clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || '',
    apiKey: import.meta.env.VITE_GOOGLE_API_KEY || '',
    appId: import.meta.env.VITE_GOOGLE_APP_ID || ''
});

function loadScript(src: string) {
    return new Promise<void>((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
        if (existing?.dataset.loaded === 'true') return resolve();
        const script = existing || document.createElement('script');
        script.src = src;
        script.async = true;
        script.defer = true;
        script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
        script.onerror = () => { script.remove(); reject(new Error(`Could not load ${src}`)); };
        if (!existing) document.head.appendChild(script);
    });
}

export function preloadGoogleSignIn() {
    signInScriptPromise ||= loadScript('https://accounts.google.com/gsi/client').catch(error => {
        signInScriptPromise = null;
        throw error;
    });
    return signInScriptPromise;
}

function loadGooglePicker() {
    pickerScriptPromise ||= loadScript('https://apis.google.com/js/api.js').then(() => new Promise<void>((resolve, reject) => {
        window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google Picker could not load')) });
    })).catch(error => {
        pickerScriptPromise = null;
        throw error;
    });
    return pickerScriptPromise;
}

function authorize(): Promise<string> {
    const { clientId } = config();
    if (!clientId) return Promise.reject(new Error('Google Drive is not configured. Set VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY, and VITE_GOOGLE_APP_ID.'));
    if (!window.google?.accounts?.oauth2) return Promise.reject(new Error('Google sign-in is still loading. Please tap Google Drive again in a moment.'));
    // Keep this request in the original click handler so mobile browsers allow its popup.
    return new Promise<string>((resolve, reject) => {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: DRIVE_SCOPE,
            callback: (response: TokenResponse) => {
                if (response.error || !response.access_token) return reject(new Error(response.error_description || response.error || 'Google authorization was cancelled'));
                accessToken = response.access_token;
                resolve(accessToken);
            },
            error_callback: (error: { type?: string }) => {
                reject(new Error(error.type === 'popup_failed_to_open'
                    ? 'Google sign-in popup was blocked. Allow popups for this site and try again.'
                    : error.type === 'popup_closed'
                        ? 'Google sign-in was closed before authorization finished.'
                        : 'Google sign-in could not open. Try again in Safari or your default browser.'));
            }
        });
        try {
            tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
        } catch (error) {
            reject(error);
        }
    });
}

async function driveFetch(path: string, init: RequestInit = {}) {
    if (!accessToken) await authorize();
    const response = await fetch(`https://www.googleapis.com${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) }
    });
    if (response.status === 401) {
        accessToken = '';
        throw new Error('Google Drive authorization expired. Reconnect Google Drive and try again.');
    }
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return response;
}

async function pickFolder(): Promise<{ id: string; name: string }> {
    const { apiKey, appId } = config();
    if (!apiKey || !appId) throw new Error('Google Picker is not configured. Set VITE_GOOGLE_API_KEY and VITE_GOOGLE_APP_ID.');
    await loadGooglePicker();
    return await new Promise((resolve, reject) => {
        const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(true)
            .setMode(window.google.picker.DocsViewMode.LIST);
        const picker = new window.google.picker.PickerBuilder()
            .setAppId(appId)
            .setDeveloperKey(apiKey)
            .setOAuthToken(accessToken)
            .addView(view)
            .setCallback((data: any) => {
                if (data.action === window.google.picker.Action.PICKED) {
                    const selected = data.docs?.[0];
                    if (selected?.id) resolve({ id: selected.id, name: selected.name || 'Google Drive folder' });
                } else if (data.action === window.google.picker.Action.CANCEL) reject(new Error('Folder selection was cancelled'));
            })
            .build();
        picker.setVisible(true);
    });
}

async function listFilesIn(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken = '';
    do {
        const query = `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`;
        const params = new URLSearchParams({ q: query, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,version)', pageSize: '1000' });
        if (pageToken) params.set('pageToken', pageToken);
        const body = await (await driveFetch(`/drive/v3/files?${params}`)).json();
        files.push(...(body.files || []));
        pageToken = body.nextPageToken || '';
    } while (pageToken);
    return files;
}

async function listFiles(): Promise<DriveFile[]> {
    return folder ? listFilesIn(folder.id) : [];
}

async function findSettingsFile(): Promise<DriveFile | null> {
    const root = await listFiles();
    const settingsFolder = root.find(file => file.name === 'setting' && file.mimeType === FOLDER_MIME);
    const workspaceSettings = settingsFolder && (await listFilesIn(settingsFolder.id)).find(file => file.name === 'settings.json');
    return workspaceSettings || root.find(file => file.name === SETTINGS_NAME) || null;
}

async function readText(fileId: string) {
    return await (await driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)).text();
}

function assetSegments(path: string): string[] {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (parts[0] !== 'assets' || parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
        throw new Error('Invalid image path. Images must be inside the workspace assets folder.');
    }
    return parts.slice(1);
}

async function assetDirectory(parts: string[], create: boolean): Promise<string | null> {
    if (!folder) throw new Error('No Google Drive folder is connected');
    let parentId = folder.id;
    for (const name of ['assets', ...parts]) {
        const existing = (await listFilesIn(parentId)).find(file => file.name === name && file.mimeType === FOLDER_MIME);
        if (existing) {
            parentId = existing.id;
        } else if (create) {
            const response = await driveFetch('/drive/v3/files?fields=id,name,mimeType', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
            });
            parentId = (await response.json() as DriveFile).id;
        } else {
            return null;
        }
    }
    return parentId;
}

async function findAsset(path: string): Promise<DriveFile | null> {
    const parts = assetSegments(path);
    const parentId = await assetDirectory(parts.slice(0, -1), false);
    return parentId
        ? (await listFilesIn(parentId)).find(file => file.name === parts.at(-1) && file.mimeType !== FOLDER_MIME) || null
        : null;
}

async function uploadAsset(file: File, path: string): Promise<void> {
    const parts = assetSegments(path);
    if (file.size > MAX_MULTIPART_UPLOAD_BYTES) throw new Error('Google Drive image uploads are limited to 5 MB. Choose a smaller image.');
    const parentId = await assetDirectory(parts.slice(0, -1), true);
    if (!parentId) throw new Error('Could not create the Google Drive assets folder.');
    const existing = await findAsset(path);
    if (existing?.version) {
        const latest = await (await driveFetch(`/drive/v3/files/${encodeURIComponent(existing.id)}?fields=id,name,version`)).json() as DriveFile;
        if (latest.version && latest.version !== existing.version) {
            throw new Error(`“${existing.name}” changed in Google Drive. Reload the workspace before overwriting it.`);
        }
    }
    const mimeType = file.type || 'application/octet-stream';
    const boundary = `math-note-${uuidv4()}`;
    const metadata = { name: parts.at(-1), mimeType, ...(!existing && { parents: [parentId] }) };
    const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
        file,
        `\r\n--${boundary}--`
    ]);
    const target = existing ? `/upload/drive/v3/files/${encodeURIComponent(existing.id)}` : '/upload/drive/v3/files';
    await driveFetch(`${target}?uploadType=multipart&fields=id,name,version`, {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
    });
}

async function createTextFile(name: string, contents: string, mimeType = 'text/markdown') {
    if (!folder) throw new Error('No Google Drive folder is connected');
    const boundary = `math-note-${uuidv4()}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder.id], mimeType })}\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${contents}\r\n--${boundary}--`;
    const response = await driveFetch('/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,version', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
    });
    return await response.json() as DriveFile;
}

async function updateTextFile(file: DriveFile, name: string, contents: string, mimeType = 'text/markdown') {
    const latest = await (await driveFetch(`/drive/v3/files/${encodeURIComponent(file.id)}?fields=id,name,modifiedTime,version`)).json() as DriveFile;
    if (file.version && latest.version && file.version !== latest.version) {
        throw new Error(`“${file.name}” changed in Google Drive. Reload the workspace before saving to avoid overwriting another edit.`);
    }
    const boundary = `math-note-${uuidv4()}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType })}\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${contents}\r\n--${boundary}--`;
    return await (await driveFetch(`/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=multipart&fields=id,name,modifiedTime,version`, {
        method: 'PATCH', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
    })).json() as DriveFile;
}

export const googleDriveWorkspace = {
    get folderName() { return folder?.name || null; },
    async connect(beforeSwitch?: () => Promise<void>) {
        await authorize();
        const selected = await pickFolder();
        await beforeSwitch?.();
        folder = selected;
        fileByBlockId.clear();
        return selected;
    },
    async disconnect() {
        if (accessToken) window.google?.accounts?.oauth2?.revoke(accessToken, () => undefined);
        accessToken = ''; folder = null; fileByBlockId.clear();
    },
    async getAssetUrl(path: string): Promise<string> {
        const asset = await findAsset(path);
        if (!asset) throw new Error(`Image not found in Google Drive: ${path}`);
        const blob = await (await driveFetch(`/drive/v3/files/${encodeURIComponent(asset.id)}?alt=media`)).blob();
        return URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: asset.mimeType || 'application/octet-stream' }));
    },
    async listAssets(): Promise<string[]> {
        const assetsId = await assetDirectory([], false);
        if (!assetsId) return [];
        const files: string[] = [];
        async function scan(parentId: string, prefix: string) {
            for (const file of await listFilesIn(parentId)) {
                const path = `${prefix}${file.name}`;
                if (file.mimeType === FOLDER_MIME) await scan(file.id, `${path}/`);
                else files.push(`assets/${path}`);
            }
        }
        await scan(assetsId, '');
        return files;
    },
    async saveAsset(file: File, filename: string): Promise<string> {
        const path = `assets/${filename}`;
        await uploadAsset(file, path);
        return path;
    },
    async loadBlocks(): Promise<BlockData[]> {
        const markdown = (await listFiles()).filter(file => file.mimeType !== FOLDER_MIME && file.name.toLowerCase().endsWith('.md'));
        const blocks = await Promise.all(markdown.map(async file => {
            const text = await readText(file.id);
            const { data, content } = parseFrontmatter(text);
            const id = metadataText(data.id, file.id);
            fileByBlockId.set(id, file);
            return { id, title: normalizeBlockTitle(metadataText(data.title, file.name.replace(/\.md$/i, ''))), label: normalizeBlockLabel(metadataText(data.label, file.name.replace(/\.md$/i, ''))), references: computeReferences(content), hasContent: content.trim().length > 0, _fileMeta: { driveFileId: file.id, version: file.version, fileName: file.name } };
        }));
        return blocks.sort((a, b) => a.title.localeCompare(b.title));
    },
    async loadBlock(id: string): Promise<BlockData | null> {
        const file = fileByBlockId.get(id); if (!file) return null;
        const { data, content } = parseFrontmatter(await readText(file.id));
        return { id, title: normalizeBlockTitle(metadataText(data.title, file.name.replace(/\.md$/i, ''))), label: normalizeBlockLabel(metadataText(data.label, file.name.replace(/\.md$/i, ''))), content, references: computeReferences(content), _fileMeta: { driveFileId: file.id, version: file.version, fileName: file.name } };
    },
    async addBlock(data: Partial<BlockData>) {
        const block = { id: uuidv4(), title: normalizeBlockTitle(metadataText(data.title, 'New Block')), label: normalizeBlockLabel(metadataText(data.label, 'block')), content: data.content || '' };
        const file = await createTextFile(makeBlockFilename(block.title, block.label, block.id), stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content));
        fileByBlockId.set(block.id, file);
        return { ...block, references: computeReferences(block.content), _fileMeta: { driveFileId: file.id, version: file.version, fileName: file.name } };
    },
    async updateBlock(block: BlockData) {
        const file = fileByBlockId.get(block.id); if (!file) throw new Error('Google Drive file not found; reload the workspace');
        const next = await updateTextFile(file, makeBlockFilename(block.title, block.label, block.id), stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content || ''));
        fileByBlockId.set(block.id, next);
        return { ...block, references: computeReferences(block.content || ''), _fileMeta: { driveFileId: next.id, version: next.version, fileName: next.name } };
    },
    async deleteBlock(id: string) { const file = fileByBlockId.get(id); if (file) await driveFetch(`/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); fileByBlockId.delete(id); },
    async loadSettings<T>(fallback: T): Promise<T> {
        const file = await findSettingsFile();
        return file ? JSON.parse(await readText(file.id)) : fallback;
    },
    async saveSettings(settings: unknown) {
        const file = await findSettingsFile();
        if (file) await updateTextFile(file, file.name, JSON.stringify(settings, null, 2), 'application/json');
        else await createTextFile(SETTINGS_NAME, JSON.stringify(settings, null, 2), 'application/json');
    }
};
