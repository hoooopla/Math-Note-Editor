import { BlockData } from './index';
import { v4 as uuidv4 } from 'uuid';
import { computeReferences, metadataText, parseFrontmatter, stringifyFrontmatter } from '../lib/block-metadata';
import { makeBlockFilename, normalizeBlockLabel, normalizeBlockTitle, validateBlockLabel, validateBlockMetadata, validateBlockTitle } from '../lib/label-policy';
import { applySafeRelabelPlan, buildSafeRelabelPlan, relabelPlanSignatureInput, SafeRelabelPlan } from '../lib/safe-relabel';
import { googleDriveWorkspace } from '../lib/google-drive-workspace';

export { computeReferences, parseFrontmatter } from '../lib/block-metadata';

export interface EditorSettings {
    macros: Record<string, string>;
    customCommands: string[];
    textCommands: string[];
    searchShortcut?: string;
    editMetadataShortcut?: string;
    goToParentShortcut?: string;
    closeTabShortcut?: string;
    reopenClosedTabShortcut?: string;
    nextTabShortcut?: string;
    previousTabShortcut?: string;
    inlineBlockTitleColorWithContent?: string;
    inlineBlockTitleColorEmpty?: string;
    inlineBlockTitleUnderlineOpacity?: number;
    inlineBlockIndentWidth?: number;
    standoutBlockTitleColorWithContent?: string;
    standoutBlockTitleColorEmpty?: string;
    standoutBlockIndentWidth?: number;
    standoutBlockTitlePaddingLeft?: number;
    standoutBlockTitlePaddingRight?: number;
    standoutBlockTitlePaddingTop?: number;
    standoutBlockTitlePaddingBottom?: number;
    standoutBlockContentPaddingLeft?: number;
    standoutBlockContentPaddingTop?: number;
    standoutBlockContentPaddingRight?: number;
    standoutBlockContentPaddingBottom?: number;
    standoutBlockBorderColor?: string;
    standoutBlockDividerColor?: string;
    standoutBlockBorderWidth?: number;
    standoutBlockDividerWidth?: number;
    standoutBlockTitleFontSizeBase?: number;
    standoutBlockTitleFontSizeStep?: number;
    standoutBlockTitleFontSizeMin?: number;
    standoutBlockBgLightenStep?: number;
    standoutBlockBgOpacityClosed?: number;
    standoutBlockBgOpacityClosedHover?: number;
    standoutBlockBgOpacityOpen?: number;
    standoutBlockBgOpacityOpenHover?: number;
    mathHighlightColor?: string;
    mathColors?: {
        command: string;
        brace: string;
        script: string;
        comment: string;
        delimiter: string;
        align: string;
        escaped: string;
    };
    mathBlockPaddingY?: number;
    workspaceSession?: WorkspaceSession;
}

export interface WorkspaceSession {
    openTabs: string[];
    activeTab: string | null;
}

export interface WorkspaceBackup {
    path: string;
    modifiedAt: number;
    size: number;
}

export interface BackendApi {
    mode: "server" | "local" | "google" | "none" | "viewer";
    init: () => Promise<boolean>;
    connectLocalFS: () => Promise<boolean>;
    connectGoogleDrive: () => Promise<{ id: string, name: string }>;
    disconnectGoogleDrive: () => Promise<void>;
    loadSettings: () => Promise<EditorSettings>;
    saveSettings: (settings: EditorSettings) => Promise<void>;
    saveWorkspaceSession: (session: WorkspaceSession) => Promise<void>;
    listBackups: () => Promise<WorkspaceBackup[]>;
    restoreBackup: (path: string) => Promise<void>;
    saveAsset: (file: File, filename: string) => Promise<string>;
    listAssets: () => Promise<string[]>;
    getAssetUrl: (path: string) => Promise<string>;
    setViewerFiles: (files: FileList) => void;
    loadBlocks: () => Promise<BlockData[]>;
    loadBlockContent: (id: string) => Promise<BlockData | null>;
    addBlock: (data: Partial<BlockData>) => Promise<BlockData>;
    updateBlock: (id: string, data: BlockData) => Promise<{ block: BlockData, updatedBlocks?: BlockData[] }>;
    repairDuplicateLabel: (id: string, newLabel: string) => Promise<BlockData>;
    previewRelabel: (oldPrefix: string, newPrefix: string) => Promise<SafeRelabelPlan>;
    commitRelabel: (plan: SafeRelabelPlan) => Promise<{ plan: SafeRelabelPlan, updatedBlocks: BlockData[] }>;
    deleteBlock: (id: string) => Promise<void>;
}

let dirHandle: FileSystemDirectoryHandle | null = null;
let useServer = true;
const viewerAssets = new Map<string, File>();
const LOCAL_BACKUP_DIRECTORY = '.math-note-backups';

interface LocalBlockFile {
    handle: FileSystemFileHandle;
    directory: FileSystemDirectoryHandle;
    name: string;
    relativePath: string;
}

const replaceLocalFile = async (handle: FileSystemFileHandle, contents: string | Blob) => {
    const writable = await handle.createWritable();
    try {
        await writable.write(contents);
        await writable.close();
    } catch (error) {
        await writable.abort(error).catch(() => {});
        throw error;
    }
};

const getLocalBackupHandle = async (relativePath: string) => {
    if (!dirHandle) throw new Error('No writable backend is connected');
    const pathParts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const fileName = pathParts.pop();
    if (!fileName) throw new Error(`Invalid backup path: ${relativePath}`);
    let backupDirectory = await dirHandle.getDirectoryHandle(LOCAL_BACKUP_DIRECTORY, { create: true });
    for (const part of pathParts) {
        backupDirectory = await backupDirectory.getDirectoryHandle(part, { create: true });
    }
    let existed = true;
    let handle: FileSystemFileHandle;
    try {
        handle = await backupDirectory.getFileHandle(`${fileName}.bak`);
    } catch {
        existed = false;
        handle = await backupDirectory.getFileHandle(`${fileName}.bak`, { create: true });
    }
    return { handle, existed };
};

const backupLocalFile = async (file: LocalBlockFile) => {
    const backup = await getLocalBackupHandle(file.relativePath);
    await replaceLocalFile(backup.handle, await file.handle.getFile());
    await file.directory.removeEntry(`${file.name}.bak`).catch(() => {});
};

const writeLocalFile = async (file: LocalBlockFile, contents: string | Blob, createBackup = true) => {
    if (createBackup) await backupLocalFile(file);
    await replaceLocalFile(file.handle, contents);
};

const migrateLocalLegacyBackups = async (
    currentDirectory: FileSystemDirectoryHandle,
    currentPath = ''
): Promise<void> => {
    for await (const entry of currentDirectory.values()) {
        if (entry.kind === 'directory') {
            if (!currentPath && entry.name === LOCAL_BACKUP_DIRECTORY) continue;
            const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
            await migrateLocalLegacyBackups(entry, nextPath);
            continue;
        }
        if (!entry.name.endsWith('.bak')) continue;
        const legacyRelativePath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        const originalRelativePath = legacyRelativePath.slice(0, -4);
        const backup = await getLocalBackupHandle(originalRelativePath);
        const sourceFile = await entry.getFile();
        const destinationIsNewer = backup.existed
            && (await backup.handle.getFile()).lastModified >= sourceFile.lastModified;
        if (!destinationIsNewer) await replaceLocalFile(backup.handle, sourceFile);
        await currentDirectory.removeEntry(entry.name);
    }
};

const localRevision = (blocks: BlockData[]) => {
    const text = JSON.stringify(blocks.map(block => [block.id, block.title, block.label, block.content || '']).sort());
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16);
};

const shortHash = (text: string) => {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16);
};

const loadAllLocalBlocks = async (): Promise<BlockData[]> => {
    if (!dirHandle) return [];
    const metadata = await api.loadBlocks();
    return (await Promise.all(metadata.map(block => api.loadBlockContent(block.id))))
        .filter((block): block is BlockData => !!block);
};

const loadAllGoogleBlocks = async (): Promise<BlockData[]> => {
    const metadata = await googleDriveWorkspace.loadBlocks();
    return (await Promise.all(metadata.map(block => googleDriveWorkspace.loadBlock(block.id))))
        .filter((block): block is BlockData => !!block);
};

const requireOk = async (response: Response, operation: string) => {
    if (response.ok) return;
    let detail = '';
    try {
        const body = await response.json();
        detail = body?.error ? `: ${body.error}` : '';
    } catch {
        // The status still provides a useful error if the response is not JSON.
    }
    throw new Error(`${operation} failed (${response.status})${detail}`);
};

const portableAssetPath = (value: string): string | null => {
    const match = value.match(/^(?:\/api\/)?assets\/(.+)$/);
    return match ? `assets/${match[1]}` : null;
};

const getFileLocationByBlockId = async (
    id: string,
    currentHandle: FileSystemDirectoryHandle | null = dirHandle,
    currentPath = ''
): Promise<LocalBlockFile | null> => {
    if (!currentHandle) return null;
    try {
        for await (const entry of currentHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                const file = await entry.getFile();
                const text = await file.text();
                const { data } = parseFrontmatter(text);
                // In recursive search, if we check by file name alone and there are duplicate names in diff folders, it might give the first.
                // It is better to rely on data.id first, or name replacing.
                if (metadataText(data.id) === id || entry.name.replace('.md', '') === id) {
                    return {
                        handle: entry,
                        directory: currentHandle,
                        name: entry.name,
                        relativePath: currentPath ? `${currentPath}/${entry.name}` : entry.name
                    };
                }
            } else if (entry.kind === 'directory') {
                const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
                const found = await getFileLocationByBlockId(id, entry, nextPath);
                if (found) return found;
            }
        }
    } catch(e) { }
    return null;
}

const getFileByBlockId = async (id: string) => (await getFileLocationByBlockId(id))?.handle || null;

const getDirectoryForPath = async (root: FileSystemDirectoryHandle, parts: string[], create = false) => {
    let current = root;
    for (const part of parts) current = await current.getDirectoryHandle(part, { create });
    return current;
};

export const api: BackendApi = {
    mode: "none",
    init: async () => {
        try {
            const res = await fetch('/api/blocks?metaOnly=true');
            if (res.ok) {
                useServer = true;
                api.mode = "server";
                return true;
            }
        } catch (e) {
            console.log("Server API not available, falling back to local FS mode");
        }
        useServer = false;
        api.mode = "none"; // requires user gesture to connect
        return false;
    },
    connectLocalFS: async () => {
        try {
            dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            await migrateLocalLegacyBackups(dirHandle).catch(error => console.warn('Could not migrate legacy backups', error));
            api.mode = "local";
            return true;
        } catch (e) {
            console.warn(e);
            return false;
        }
    },
    connectGoogleDrive: async () => {
        const selected = await googleDriveWorkspace.connect();
        useServer = false;
        api.mode = 'google';
        return selected;
    },
    disconnectGoogleDrive: async () => {
        await googleDriveWorkspace.disconnect();
        api.mode = 'none';
    },
    loadSettings: async () => {
        const defaultSettings: EditorSettings = { 
            macros: {}, 
            customCommands: [], 
            textCommands: [], 
            searchShortcut: "meta+k",
            editMetadataShortcut: "f2",
            goToParentShortcut: "mod+shift+arrowup",
            closeTabShortcut: "mod+w",
            reopenClosedTabShortcut: "mod+shift+t",
            nextTabShortcut: "ctrl+tab",
            previousTabShortcut: "ctrl+shift+tab",
            inlineBlockTitleColorWithContent: "#a8b5c2",
            inlineBlockTitleColorEmpty: "#FF997D",
            inlineBlockTitleUnderlineOpacity: 100,
            inlineBlockIndentWidth: 16,
            standoutBlockTitleColorWithContent: "#a8b5c2",
            standoutBlockTitleColorEmpty: "#FF997D",
            standoutBlockIndentWidth: 0,
            standoutBlockTitlePaddingLeft: 10,
            standoutBlockTitlePaddingRight: 6,
            standoutBlockTitlePaddingTop: 5,
            standoutBlockTitlePaddingBottom: 5,
            standoutBlockContentPaddingLeft: 10,
            standoutBlockContentPaddingTop: 8,
            standoutBlockContentPaddingRight: 12,
            standoutBlockContentPaddingBottom: 12,
            standoutBlockBorderColor: "#ffffff",
            standoutBlockDividerColor: "#ffffff",
            standoutBlockBorderWidth: 1,
            standoutBlockDividerWidth: 1,
            standoutBlockTitleFontSizeBase: 24,
            standoutBlockTitleFontSizeStep: 2,
            standoutBlockTitleFontSizeMin: 18,
            standoutBlockBgLightenStep: 2,
            standoutBlockBgOpacityClosed: 30,
            standoutBlockBgOpacityClosedHover: 40,
            standoutBlockBgOpacityOpen: 80,
            standoutBlockBgOpacityOpenHover: 90,
            mathHighlightColor: "#d19a66",
            mathColors: { command: "#61afef", brace: "#e5c07b", script: "#c678dd", comment: "#8b949e", delimiter: "#98c379", align: "#e06c75", escaped: "#56b6c2" }
        };
        if (useServer) {
            const res = await fetch('/api/settings');
            await requireOk(res, 'Loading settings');
            return await res.json();
        }
        if (api.mode === 'google') return googleDriveWorkspace.loadSettings(defaultSettings);
        if (api.mode === "local" && dirHandle) {
            try {
                const settingDirHandle = await dirHandle.getDirectoryHandle('setting');
                const fileHandle = await settingDirHandle.getFileHandle('settings.json');
                const file = await fileHandle.getFile();
                return JSON.parse(await file.text());
            } catch(e) {
                return defaultSettings;
            }
        }
        return defaultSettings;
    },
    saveSettings: async (settings) => {
        if (useServer) {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            await requireOk(res, 'Saving settings');
        } else if (api.mode === 'google') {
            await googleDriveWorkspace.saveSettings(settings);
        } else if (api.mode === "local" && dirHandle) {
            const settingDirHandle = await dirHandle.getDirectoryHandle('setting', { create: true });
            let existed = true;
            let fileHandle: FileSystemFileHandle;
            try {
                fileHandle = await settingDirHandle.getFileHandle('settings.json');
            } catch {
                existed = false;
                fileHandle = await settingDirHandle.getFileHandle('settings.json', { create: true });
            }
            const file: LocalBlockFile = {
                handle: fileHandle,
                directory: settingDirHandle,
                name: 'settings.json',
                relativePath: 'setting/settings.json'
            };
            await writeLocalFile(file, JSON.stringify(settings, null, 2), existed);
        }
    },
    saveWorkspaceSession: async (session) => {
        if (useServer) {
            const res = await fetch('/api/workspace/session', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session)
            });
            await requireOk(res, 'Saving workspace session');
        } else if (api.mode === 'google') {
            const current = await api.loadSettings();
            await api.saveSettings({ ...current, workspaceSession: session });
        } else if (api.mode === 'local' && dirHandle) {
            const current = await api.loadSettings();
            await api.saveSettings({ ...current, workspaceSession: session });
        }
    },
    listBackups: async () => {
        if (useServer) {
            const res = await fetch('/api/backups');
            await requireOk(res, 'Listing backups');
            return await res.json();
        }
        if (api.mode !== 'local' || !dirHandle) return [];
        const results: WorkspaceBackup[] = [];
        try {
            const root = await dirHandle.getDirectoryHandle(LOCAL_BACKUP_DIRECTORY);
            const scan = async (directory: FileSystemDirectoryHandle, prefix = ''): Promise<void> => {
                for await (const entry of directory.values()) {
                    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
                    if (entry.kind === 'directory') await scan(entry, relative);
                    else if (entry.name.endsWith('.bak')) {
                        const file = await entry.getFile();
                        results.push({ path: relative.slice(0, -4), modifiedAt: file.lastModified, size: file.size });
                    }
                }
            };
            await scan(root);
        } catch { return []; }
        return results.sort((a, b) => b.modifiedAt - a.modifiedAt);
    },
    restoreBackup: async (relativePath) => {
        if (useServer) {
            const res = await fetch('/api/backups/restore', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: relativePath })
            });
            await requireOk(res, 'Restoring backup');
            return;
        }
        if (api.mode !== 'local' || !dirHandle) throw new Error('No writable workspace is connected');
        const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
        if (!parts.length || parts.some(part => part === '..' || part === '.')) throw new Error('Invalid backup path');
        const name = parts.pop()!;
        const backupRoot = await dirHandle.getDirectoryHandle(LOCAL_BACKUP_DIRECTORY);
        const backupDirectory = await getDirectoryForPath(backupRoot, parts);
        const backupHandle = await backupDirectory.getFileHandle(`${name}.bak`);
        const backupContents = await backupHandle.getFile();
        const targetDirectory = await getDirectoryForPath(dirHandle, parts, true);
        let targetHandle: FileSystemFileHandle;
        let currentContents: File | null = null;
        try {
            targetHandle = await targetDirectory.getFileHandle(name);
            currentContents = await targetHandle.getFile();
        } catch {
            targetHandle = await targetDirectory.getFileHandle(name, { create: true });
        }
        await replaceLocalFile(targetHandle, backupContents);
        if (currentContents) await replaceLocalFile(backupHandle, currentContents);
    },
    saveAsset: async (file, filename) => {
        if (api.mode === 'google') throw new Error('Image attachments are not supported in Google Drive workspaces yet.');
        if (useServer) {
            const base64: string = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const res = await fetch('/api/assets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath: 'assets/' + filename, content: base64 }),
            });
            await requireOk(res, 'Saving asset');
            const json = await res.json();
            if (!json.url) throw new Error('Saving asset failed: server returned no URL');
            return json.url;
        } else if (api.mode === "local" && dirHandle) {
            const assetsDir = await dirHandle.getDirectoryHandle('assets', { create: true });
            const pathParts = filename.split('/');
            let currentDir = assetsDir;
            for (let i = 0; i < pathParts.length - 1; i++) {
                currentDir = await currentDir.getDirectoryHandle(pathParts[i], { create: true });
            }
            const assetName = pathParts[pathParts.length - 1];
            let existed = true;
            let fileHandle: FileSystemFileHandle;
            try {
                fileHandle = await currentDir.getFileHandle(assetName);
            } catch {
                existed = false;
                fileHandle = await currentDir.getFileHandle(assetName, { create: true });
            }
            await writeLocalFile({
                handle: fileHandle,
                directory: currentDir,
                name: assetName,
                relativePath: `assets/${filename}`
            }, file, existed);
            return 'assets/' + filename; 
        }
        return '';
    },
    listAssets: async () => {
        if (useServer) {
            try {
                const res = await fetch('/api/assets-list');
                await requireOk(res, 'Listing assets');
                return await res.json();
            } catch {
                return [];
            }
        }
        if (api.mode === "local" && dirHandle) {
            const files: string[] = [];
            try {
                const assetsDir = await dirHandle.getDirectoryHandle('assets', { create: false });
                async function scanDir(handle: FileSystemDirectoryHandle, currentPath = '') {
                    for await (const entry of handle.values()) {
                        if (entry.kind === 'file') {
                            files.push(currentPath ? `${currentPath}/${entry.name}` : entry.name);
                        } else if (entry.kind === 'directory') {
                            await scanDir(entry, currentPath ? `${currentPath}/${entry.name}` : entry.name);
                        }
                    }
                }
                await scanDir(assetsDir);
            } catch(e) {
                // assets dir might not exist
            }
            return files;
        }
        if (api.mode === "viewer") return Array.from(viewerAssets.keys());
        return [];
    },
    setViewerFiles: (files) => {
        viewerAssets.clear();
        for (const file of Array.from(files)) {
            const relativePath = file.webkitRelativePath.replace(/\\/g, '/');
            const assetsMarker = relativePath.indexOf('/assets/');
            const assetPath = relativePath.startsWith('assets/')
                ? relativePath
                : assetsMarker >= 0
                    ? `assets/${relativePath.slice(assetsMarker + '/assets/'.length)}`
                    : null;
            if (assetPath) viewerAssets.set(assetPath, file);
        }
    },
    getAssetUrl: async (path) => {
        if (/^(?:https?:|data:|blob:)/.test(path)) return path;
        const assetPath = portableAssetPath(path);
        if (useServer) {
            if (assetPath) return `/api/${assetPath}`;
            return path; // fallback
        }
        if (api.mode === "local" && dirHandle) {
            if (assetPath) {
                try {
                    const assetsDir = await dirHandle.getDirectoryHandle('assets', { create: false });
                    const pathParts = assetPath.replace('assets/', '').split('/');
                    let currentDir = assetsDir;
                    for (let i = 0; i < pathParts.length - 1; i++) {
                        currentDir = await currentDir.getDirectoryHandle(pathParts[i], { create: false });
                    }
                    const fileHandle = await currentDir.getFileHandle(pathParts[pathParts.length - 1], { create: false });
                    const file = await fileHandle.getFile();
                    return URL.createObjectURL(file);
                } catch (e) {
                    return path;
                }
            }
        }
        if (api.mode === "viewer" && assetPath) {
            const file = viewerAssets.get(assetPath);
            if (file) return URL.createObjectURL(file);
        }
        return path;
    },
    loadBlocks: async () => {
        if (useServer) {
            const res = await fetch('/api/blocks?metaOnly=true');
            await requireOk(res, 'Loading blocks');
            return await res.json();
        }
        if (api.mode === 'google') return googleDriveWorkspace.loadBlocks();
        if (api.mode === "local" && dirHandle) {
            const blocksMap = new Map<string, BlockData>();
            
            async function scanDir(handle: FileSystemDirectoryHandle, currentPath = '') {
                for await (const entry of handle.values()) {
                    if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                        const file = await entry.getFile();
                        const text = await file.text();
                        const { data, content } = parseFrontmatter(text);
                        // Store the relative path instead of just the name in the map, or use data.id
                        const fileId = currentPath ? `${currentPath}/${entry.name}`.replace('.md', '') : entry.name.replace('.md', '');
                        const id = metadataText(data.id, fileId);
                        blocksMap.set(id, {
                            id,
                            title: normalizeBlockTitle(metadataText(data.title)),
                            label: normalizeBlockLabel(metadataText(data.label)),
                            references: computeReferences(content),
                            hasContent: content.trim().length > 0,
                            _fileMeta: { fileName: currentPath ? `${currentPath}/${entry.name}` : entry.name }
                        });
                    } else if (entry.kind === 'directory') {
                        const newPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
                        await scanDir(entry, newPath);
                    }
                }
            }
            
            await scanDir(dirHandle);

            const blocks = Array.from(blocksMap.values());
            blocks.sort((a,b) => a.title.localeCompare(b.title));
            return blocks;
        }
        return [];
    },
    loadBlockContent: async (id) => {
        if (useServer) {
            const res = await fetch(`/api/blocks/${encodeURIComponent(id)}`);
            return res.ok ? await res.json() : null;
        }
        if (api.mode === 'google') return googleDriveWorkspace.loadBlock(id);
        if (api.mode === "local" && dirHandle) {
            const entry = await getFileByBlockId(id);
            if (entry) {
                const file = await entry.getFile();
                const { data, content } = parseFrontmatter(await file.text());
                return {
                    id: metadataText(data.id, id),
                    title: normalizeBlockTitle(metadataText(data.title)),
                    label: normalizeBlockLabel(metadataText(data.label)),
                    content
                };
            }
        }
        return null;
    },
    addBlock: async (data) => {
        if (useServer) {
            const res = await fetch('/api/blocks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            await requireOk(res, 'Creating block');
            return await res.json();
        }
        if (api.mode === 'google') {
            const title = normalizeBlockTitle(metadataText(data.title, 'New Block'));
            const label = normalizeBlockLabel(metadataText(data.label, 'block'));
            const metadataError = validateBlockMetadata(title, label);
            if (metadataError) throw new Error(metadataError);
            return googleDriveWorkspace.addBlock({ ...data, title, label });
        }
        if (api.mode === "local" && dirHandle) {
            const id = uuidv4();
            const title = normalizeBlockTitle(metadataText(data.title, "New Block"));
            const label = normalizeBlockLabel(metadataText(data.label, "block"));
            const metadataError = validateBlockMetadata(title, label);
            if (metadataError) throw new Error(metadataError);
            const block = { id, title, label, content: data.content || "", references: computeReferences(data.content || "") };

            const baseFilename = makeBlockFilename(block.title, block.label, block.id);
            let newFilename = baseFilename;
            let counter = 1;
            while(true) {
                try {
                    await dirHandle.getFileHandle(newFilename);
                    newFilename = baseFilename.replace(/\.md$/, `-${counter}.md`);
                    counter++;
                } catch(e) {
                    break;
                }
            }

            const fileHandle = await dirHandle.getFileHandle(newFilename, { create: true });
            await replaceLocalFile(fileHandle, stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content));
            return block;
        }
        throw new Error(api.mode === 'viewer' ? 'Read-only viewer cannot create blocks' : 'No writable backend is connected');
    },
    updateBlock: async (id, block) => {
        const normalizedBlock = {
            ...block,
            title: normalizeBlockTitle(metadataText(block.title)),
            label: normalizeBlockLabel(metadataText(block.label))
        };
        const metadataError = validateBlockTitle(normalizedBlock.title) || validateBlockLabel(normalizedBlock.label);
        if (metadataError) throw new Error(metadataError);
        block = normalizedBlock;
        if (useServer) {
            const res = await fetch(`/api/blocks/${encodeURIComponent(id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(block),
                keepalive: true
            });
            await requireOk(res, 'Saving block');
            return await res.json();
        }
        if (api.mode === 'google') {
            const updated = await googleDriveWorkspace.updateBlock(block);
            return { block: updated };
        }
        if (api.mode === "local" && dirHandle) {
            const location = await getFileLocationByBlockId(id);
            if (location) {
                const filename = location.name;
                const expectedFilename = makeBlockFilename(block.title, block.label, block.id);
                const contents = stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content || "");
                if (filename !== expectedFilename) {
                    let newFilename = expectedFilename;
                    let counter = 1;
                    while(true) {
                        try {
                            await location.directory.getFileHandle(newFilename);
                            newFilename = expectedFilename.replace(/\.md$/, `-${counter}.md`);
                            counter++;
                        } catch(e) {
                            break;
                        }
                    }
                    await backupLocalFile(location);
                    const newHandle = await location.directory.getFileHandle(newFilename, { create: true });
                    try {
                        await replaceLocalFile(newHandle, contents);
                        await location.directory.removeEntry(filename);
                    } catch(error) {
                        await location.directory.removeEntry(newFilename).catch(() => {});
                        throw error;
                    }
                } else {
                    await writeLocalFile(location, contents);
                }
                
                // Client-side cascades (simplified for FS mode)
                block.references = computeReferences(block.content || "");
                return { block };
            }
        }
        if (api.mode === 'viewer') throw new Error('Read-only viewer cannot update blocks');
        throw new Error('No writable backend is connected');
    },
    repairDuplicateLabel: async (id, newLabel) => {
        newLabel = normalizeBlockLabel(metadataText(newLabel));
        const labelError = validateBlockLabel(newLabel);
        if (labelError) throw new Error(labelError);
        if (useServer) {
            const res = await fetch(`/api/workspace/duplicate-labels/${encodeURIComponent(id)}/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newLabel })
            });
            await requireOk(res, 'Resolving duplicate label');
            return await res.json();
        }
        if ((api.mode === 'local' && dirHandle) || api.mode === 'google') {
            const blocks = api.mode === 'google' ? await loadAllGoogleBlocks() : await loadAllLocalBlocks();
            const current = blocks.find(block => block.id === id);
            if (!current) throw new Error('Block not found');
            const duplicateCount = blocks.filter(block => normalizeBlockLabel(block.label) === current.label).length;
            if (duplicateCount < 2) throw new Error(`Label "${current.label}" is no longer duplicated`);
            if (blocks.some(block => block.id !== id && normalizeBlockLabel(block.label) === newLabel)) {
                throw new Error(`Label "${newLabel}" already exists`);
            }
            const result = await api.updateBlock(id, { ...current, label: newLabel });
            return result.block;
        }
        throw new Error(api.mode === 'viewer' ? 'Read-only viewer cannot repair labels' : 'No writable backend is connected');
    },
    previewRelabel: async (oldPrefix, newPrefix) => {
        if (useServer) {
            const res = await fetch('/api/relabel/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPrefix, newPrefix })
            });
            await requireOk(res, 'Previewing tree transformation');
            return await res.json();
        }
        if ((api.mode === 'local' && dirHandle) || api.mode === 'google') {
            const blocks = api.mode === 'google' ? await loadAllGoogleBlocks() : await loadAllLocalBlocks();
            const plan = buildSafeRelabelPlan(blocks, oldPrefix, newPrefix);
            plan.revision = localRevision(blocks);
            plan.signature = shortHash(relabelPlanSignatureInput(plan));
            const fileNames = new Map<string, string>();
            for (const id of new Set([
                ...plan.blockChanges.map(change => change.id),
                ...plan.referenceImpacts.map(impact => impact.blockId)
            ])) {
                if (api.mode === 'google') {
                    const block = blocks.find(item => item.id === id);
                    if (block?._fileMeta?.fileName) fileNames.set(id, block._fileMeta.fileName);
                } else {
                    const location = await getFileLocationByBlockId(id);
                    if (location) fileNames.set(id, location.relativePath);
                }
            }
            for (const change of plan.blockChanges) change.fileName = fileNames.get(change.id);
            for (const impact of plan.referenceImpacts) impact.fileName = fileNames.get(impact.blockId);
            return plan;
        }
        throw new Error(api.mode === 'viewer' ? 'Read-only viewer cannot relabel blocks' : 'No writable backend is connected');
    },
    commitRelabel: async (preview) => {
        if (useServer) {
            const res = await fetch('/api/relabel/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPrefix: preview.oldPrefix, newPrefix: preview.newPrefix, revision: preview.revision, signature: preview.signature })
            });
            await requireOk(res, 'Applying tree transformation');
            return await res.json();
        }
        if ((api.mode === 'local' && dirHandle) || api.mode === 'google') {
            const blocks = api.mode === 'google' ? await loadAllGoogleBlocks() : await loadAllLocalBlocks();
            const current = buildSafeRelabelPlan(blocks, preview.oldPrefix, preview.newPrefix);
            current.revision = localRevision(blocks);
            current.signature = shortHash(relabelPlanSignatureInput(current));
            if (current.revision !== preview.revision && current.signature !== preview.signature) {
                throw new Error('The workspace changed after this preview. Review it again before confirming.');
            }
            if (current.conflicts.length) throw new Error(current.conflicts.join(' '));
            const planned = applySafeRelabelPlan(blocks, current);
            if (api.mode === 'google') {
                const updatedBlocks: BlockData[] = [];
                for (let index = 0; index < blocks.length; index++) {
                    const before = blocks[index];
                    const after = planned[index];
                    if (before.label === after.label && before.content === after.content) continue;
                    updatedBlocks.push(await googleDriveWorkspace.updateBlock({
                        ...before,
                        label: after.label,
                        content: after.content,
                        references: computeReferences(after.content || ''),
                        hasContent: (after.content || '').trim().length > 0
                    }));
                }
                return { plan: current, updatedBlocks };
            }
            const updatedBlocks: BlockData[] = [];
            const prepared: Array<{ file: LocalBlockFile, original: string, updated: BlockData }> = [];
            for (let index = 0; index < blocks.length; index++) {
                const before = blocks[index];
                const after = planned[index];
                if (before.label === after.label && before.content === after.content) continue;
                const file = await getFileLocationByBlockId(before.id);
                if (!file) throw new Error(`Could not find the file for “${before.title}”.`);
                const updated: BlockData = {
                    ...before,
                    label: after.label,
                    content: after.content,
                    references: computeReferences(after.content || ''),
                    hasContent: (after.content || '').trim().length > 0
                };
                prepared.push({ file, original: await (await file.handle.getFile()).text(), updated });
                updatedBlocks.push(updated);
            }
            const written: typeof prepared = [];
            try {
                for (const item of prepared) {
                    await writeLocalFile(
                        item.file,
                        stringifyFrontmatter({ id: item.updated.id, title: item.updated.title, label: item.updated.label }, item.updated.content || '')
                    );
                    written.push(item);
                }
            } catch (error) {
                for (const item of written) {
                    await replaceLocalFile(item.file.handle, item.original);
                }
                throw error;
            }
            return { plan: current, updatedBlocks };
        }
        throw new Error(api.mode === 'viewer' ? 'Read-only viewer cannot relabel blocks' : 'No writable backend is connected');
    },
    deleteBlock: async (id) => {
        if (useServer) {
            const res = await fetch(`/api/blocks/${encodeURIComponent(id)}`, { method: 'DELETE' });
            await requireOk(res, 'Deleting block');
        } else if (api.mode === 'google') {
            await googleDriveWorkspace.deleteBlock(id);
        } else if (api.mode === "local" && dirHandle) {
            const file = await getFileLocationByBlockId(id);
            if (file) {
                await backupLocalFile(file);
                await file.directory.removeEntry(file.name);
            }
        } else if (api.mode === 'viewer') {
            throw new Error('Read-only viewer cannot delete blocks');
        } else {
            throw new Error('No writable backend is connected');
        }
    }
};
