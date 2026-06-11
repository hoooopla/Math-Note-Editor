import { BlockData } from './index';
import { v4 as uuidv4 } from 'uuid';

export interface BackendApi {
    mode: "server" | "local" | "none";
    init: () => Promise<boolean>;
    connectLocalFS: () => Promise<boolean>;
    loadMacros: () => Promise<Record<string, string>>;
    saveMacros: (macros: Record<string, string>) => Promise<void>;
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

const getFileByBlockId = async (id: string): Promise<FileSystemFileHandle | null> => {
    if (!dirHandle) return null;
    try {
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                const file = await entry.getFile();
                const text = await file.text();
                const { data } = parseFrontmatter(text);
                if (data.id === id || entry.name.replace('.md', '') === id) {
                    return entry;
                }
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
    loadMacros: async () => {
        if (useServer) {
            const res = await fetch('/api/macros');
            return res.ok ? await res.json() : {};
        }
        if (api.mode === "local" && dirHandle) {
            try {
                const fileHandle = await dirHandle.getFileHandle('macros.json');
                const file = await fileHandle.getFile();
                return JSON.parse(await file.text());
            } catch(e) {
                return {};
            }
        }
        return {};
    },
    saveMacros: async (macros) => {
        if (useServer) {
            await fetch('/api/macros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(macros),
            });
        } else if (api.mode === "local" && dirHandle) {
            const fileHandle = await dirHandle.getFileHandle('macros.json', { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(macros, null, 2));
            await writable.close();
        }
    },
    loadBlocks: async () => {
        if (useServer) {
            const res = await fetch('/api/blocks?metaOnly=true');
            return await res.json();
        }
        if (api.mode === "local" && dirHandle) {
            const blocksMap = new Map<string, BlockData>();
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                    const file = await entry.getFile();
                    const text = await file.text();
                    const { data, content } = parseFrontmatter(text);
                    const id = data.id || entry.name.replace('.md', '');
                    blocksMap.set(id, {
                        id,
                        title: data.title || '',
                        label: data.label || '',
                        hasContent: content.trim().length > 0
                    });
                }
            }
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
