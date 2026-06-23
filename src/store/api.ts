import { BlockData } from './index';
import { v4 as uuidv4 } from 'uuid';

export interface EditorSettings {
    macros: Record<string, string>;
    customCommands: string[];
    textCommands: string[];
    searchShortcut?: string;
    inlineBlockTitleColorWithContent?: string;
    inlineBlockTitleColorEmpty?: string;
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
}

export interface BackendApi {
    mode: "server" | "local" | "none";
    init: () => Promise<boolean>;
    connectLocalFS: () => Promise<boolean>;
    loadSettings: () => Promise<EditorSettings>;
    saveSettings: (settings: EditorSettings) => Promise<void>;
    saveAsset: (file: File, filename: string) => Promise<string>;
    listAssets: () => Promise<string[]>;
    getAssetUrl: (path: string) => Promise<string>;
    loadBlocks: () => Promise<BlockData[]>;
    loadBlockContent: (id: string, blocks: BlockData[]) => Promise<BlockData | null>;
    addBlock: (data: Partial<BlockData>, existingBlocks: BlockData[]) => Promise<BlockData>;
    updateBlock: (id: string, data: BlockData, existingBlocks: BlockData[]) => Promise<{ block: BlockData, updatedBlocks?: BlockData[] }>;
    deleteBlock: (id: string, blocks: BlockData[]) => Promise<void>;
}

let dirHandle: FileSystemDirectoryHandle | null = null;
let useServer = true;

const parseFrontmatter = (text: string) => {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)/);
    if (!match) return { data: {}, content: text };
    
    const data: Record<string, string> = {};
    match[1].split('\n').forEach(line => {
        const idx = line.indexOf(':');
        if (idx > -1) {
            const key = line.substring(0, idx).trim();
            const val = line.substring(idx + 1).trim();
            data[key] = val;
        }
    });
    return { data, content: match[2] };
};

const stringifyFrontmatter = (data: Record<string, string>, content: string) => {
    let fm = '---\n';
    for (const [k, v] of Object.entries(data)) {
        fm += `${k}: ${v}\n`;
    }
    fm += '---\n';
    return fm + content;
};

const getFileByBlockId = async (id: string, currentHandle: FileSystemDirectoryHandle | null = dirHandle): Promise<FileSystemFileHandle | null> => {
    if (!currentHandle) return null;
    try {
        for await (const entry of currentHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                const file = await entry.getFile();
                const text = await file.text();
                const { data } = parseFrontmatter(text);
                // In recursive search, if we check by file name alone and there are duplicate names in diff folders, it might give the first.
                // It is better to rely on data.id first, or name replacing.
                if (data.id === id || entry.name.replace('.md', '') === id) {
                    return entry;
                }
            } else if (entry.kind === 'directory') {
                const found = await getFileByBlockId(id, entry);
                if (found) return found;
            }
        }
    } catch(e) { }
    return null;
}

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
            api.mode = "local";
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    },
    loadSettings: async () => {
        const defaultSettings: EditorSettings = { 
            macros: {}, 
            customCommands: [], 
            textCommands: [], 
            searchShortcut: "meta+k",
            inlineBlockTitleColorWithContent: "#a8b5c2",
            inlineBlockTitleColorEmpty: "#FF997D",
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
            mathHighlightColor: "#d19a66",
            mathColors: { command: "#61afef", brace: "#e5c07b", script: "#c678dd", comment: "#8b949e", delimiter: "#98c379", align: "#e06c75", escaped: "#56b6c2" }
        };
        if (useServer) {
            const res = await fetch('/api/settings');
            return res.ok ? await res.json() : defaultSettings;
        }
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
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
        } else if (api.mode === "local" && dirHandle) {
            const settingDirHandle = await dirHandle.getDirectoryHandle('setting', { create: true });
            const fileHandle = await settingDirHandle.getFileHandle('settings.json', { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(settings, null, 2));
            await writable.close();
        }
    },
    saveAsset: async (file, filename) => {
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
            const json = await res.json();
            return json.url;
        } else if (api.mode === "local" && dirHandle) {
            const assetsDir = await dirHandle.getDirectoryHandle('assets', { create: true });
            const pathParts = filename.split('/');
            let currentDir = assetsDir;
            for (let i = 0; i < pathParts.length - 1; i++) {
                currentDir = await currentDir.getDirectoryHandle(pathParts[i], { create: true });
            }
            const fileHandle = await currentDir.getFileHandle(pathParts[pathParts.length - 1], { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(file);
            await writable.close();
            return 'assets/' + filename; 
        }
        return '';
    },
    listAssets: async () => {
        if (useServer) {
            try {
                const res = await fetch('/api/assets-list');
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
        return [];
    },
    getAssetUrl: async (path) => {
        if (/^https?:\/\//.test(path)) return path;
        if (useServer) {
            if (path.startsWith('assets/')) {
                return `/api/${path}`;
            }
            if (path.startsWith('/api/assets/')) return path;
            return path; // fallback
        }
        if (api.mode === "local" && dirHandle) {
            if (path.startsWith('assets/')) {
                try {
                    const assetsDir = await dirHandle.getDirectoryHandle('assets', { create: false });
                    const pathParts = path.replace('assets/', '').split('/');
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
        return path;
    },
    loadBlocks: async () => {
        if (useServer) {
            const res = await fetch('/api/blocks?metaOnly=true');
            return await res.json();
        }
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
                        const id = data.id || fileId;
                        blocksMap.set(id, {
                            id,
                            title: data.title || '',
                            label: data.label || '',
                            hasContent: content.trim().length > 0
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
    loadBlockContent: async (id, blocks) => {
        if (useServer) {
            const res = await fetch(`/api/blocks/${id}`);
            return res.ok ? await res.json() : null;
        }
        if (api.mode === "local" && dirHandle) {
            const entry = await getFileByBlockId(id);
            if (entry) {
                const file = await entry.getFile();
                const { data, content } = parseFrontmatter(await file.text());
                return {
                    id: data.id || id,
                    title: data.title || '',
                    label: data.label || '',
                    content
                };
            }
        }
        return null;
    },
    addBlock: async (data, existingBlocks) => {
        if (useServer) {
            const res = await fetch('/api/blocks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return await res.json();
        }
        if (api.mode === "local" && dirHandle) {
            const id = uuidv4();
            const block = { id, title: data.title || "New Block", label: data.label || "block", content: data.content || "" };
            
            const safeTitle = (block.title).replace(/[\/\\?%*:|"<>]/g, '-').trim() || "Untitled";
            let newFilename = `${safeTitle}.md`;
            let counter = 1;
            while(true) {
                try {
                    await dirHandle.getFileHandle(newFilename);
                    newFilename = `${safeTitle}-${counter}.md`;
                    counter++;
                } catch(e) {
                    break;
                }
            }

            const fileHandle = await dirHandle.getFileHandle(newFilename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content));
            await writable.close();
            return block;
        }
        const b = { id: uuidv4(), title: 'New', label: 'block', content: '', ...data };
        return b;
    },
    updateBlock: async (id, block, existingBlocks) => {
        if (useServer) {
            const res = await fetch(`/api/blocks/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(block)
            });
            return await res.json();
        }
        if (api.mode === "local" && dirHandle) {
            // Write to local file
            const entry = await getFileByBlockId(id);
            if (entry) {
                let filename = entry.name;
                const safeTitle = (block.title).replace(/[\/\\?%*:|"<>]/g, '-').trim() || "Untitled";
                
                // If title changed, maybe rename the file?
                // For simplicity, FS mode just keeps same filename or we can create new and delete old
                if (!filename.startsWith(safeTitle)) {
                    // Try to rename
                    let newFilename = `${safeTitle}.md`;
                    try {
                        const newHandle = await dirHandle.getFileHandle(newFilename, { create: true });
                        const writable = await newHandle.createWritable();
                        await writable.write(stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content || ""));
                        await writable.close();
                        
                        await dirHandle.removeEntry(filename);
                    } catch(e) {
                        // fallback to just writing old file
                        const writable = await entry.createWritable();
                        await writable.write(stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content || ""));
                        await writable.close();
                    }
                } else {
                    const writable = await entry.createWritable();
                    await writable.write(stringifyFrontmatter({ id: block.id, title: block.title, label: block.label }, block.content || ""));
                    await writable.close();
                }
                
                // Client-side cascades (simplified for FS mode)
                return { block };
            }
        }
        return { block };
    },
    deleteBlock: async (id, blocks) => {
        if (useServer) {
            await fetch(`/api/blocks/${id}`, { method: 'DELETE' });
        } else if (api.mode === "local" && dirHandle) {
            const entry = await getFileByBlockId(id);
            if (entry) {
                await dirHandle.removeEntry(entry.name);
            }
        }
    }
};
