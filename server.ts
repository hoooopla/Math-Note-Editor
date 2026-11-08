import express from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { computeReferences, metadataText, parseFrontmatter, stringifyFrontmatter } from "./src/lib/block-metadata";
import { makeInitialBlockFilename, normalizeBlockLabel, normalizeBlockTitle, validateBlockLabel, validateBlockMetadata, validateBlockTitle } from "./src/lib/label-policy";
import { validateEditorSettings } from "./src/lib/settings-validation";
import { applySafeRelabelPlan, buildSafeRelabelPlan, relabelPlanSignatureInput, SafeRelabelPlan } from "./src/lib/safe-relabel";
import { atomicWriteFile, backupFile } from "./src/lib/atomic-file";
import { createBlocksViewFixture } from "./src/lib/blocks-view-fixture";
import { validateAssetPath } from "./src/lib/asset-reference";
import { assetMoveRevisionInput, buildAssetMovePlan, replaceAssetImageReferences, AssetMovePlan } from "./src/lib/safe-asset-move";
import { imageSignatureMatches, validateImageFilename, validateImageUpload } from "./src/lib/image-upload-policy";

const app = express();
const portArgumentIndex = process.argv.indexOf("--port");
const requestedPort = portArgumentIndex >= 0 ? Number(process.argv[portArgumentIndex + 1]) : 3000;
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535 ? requestedPort : 3000;
const HOST = process.env.MATH_NOTE_DESKTOP === "true" ? "127.0.0.1" : (process.env.HOST || "127.0.0.1");
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");
const isTestMode = process.argv.includes("--test-mode");
app.use(express.json({ limit: '20mb' }));

// A workspace is portable between the web server and desktop app. Markdown
// notes live at its root, with shared settings in setting/settings.json and
// pasted files in assets/. Keep the repository's blocks/ folder as the web
// default for backwards compatibility.
const WORKSPACE_DIR = path.resolve(process.env.MATH_NOTE_WORKSPACE || path.join(process.cwd(), "blocks"));
const BLOCKS_DIR = WORKSPACE_DIR;
const BACKUP_DIR = path.join(WORKSPACE_DIR, ".math-note-backups");
const RECOVERY_DIR = path.join(WORKSPACE_DIR, ".math-note-recovery");
const DIST_DIR = path.resolve(process.env.MATH_NOTE_DIST_DIR || path.join(process.cwd(), "dist"));

interface BlockData {
    id: string;
    title: string;
    label: string;
    content?: string;
    hasContent?: boolean;
    references?: string[];
    revision?: string;
}

let blocksMap = new Map<string, BlockData>();
let sseClients: express.Response[] = [];
let testSettings: Record<string, unknown> | null = null;
let testWorkspaceSession: { openTabs: string[]; activeTab: string | null; lockedTabs: string[] } | null = null;
const testAssets = new Map<string, { buffer: Buffer; contentType: string }>();
const testRecoveryDrafts = new Map<string, Record<string, unknown>>();
const assetWriteLocks = new Map<string, Promise<void>>();

async function withAssetWriteLock<T>(assetPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = assetWriteLocks.get(assetPath) || Promise.resolve();
    let release = () => {};
    const lock = new Promise<void>(resolve => { release = resolve; });
    assetWriteLocks.set(assetPath, lock);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (assetWriteLocks.get(assetPath) === lock) assetWriteLocks.delete(assetPath);
    }
}

app.get("/api/runtime", (_req, res) => {
    res.json({ testMode: isTestMode, desktop: process.env.MATH_NOTE_DESKTOP === "true", workspaceName: path.basename(WORKSPACE_DIR) });
});

app.post('/api/test/blocks-view-fixture', (req, res) => {
    if (!isTestMode) return res.status(404).json({ error: 'Not found' });
    const requested = Number(req.body?.size || 360);
    const size = Number.isFinite(requested) ? Math.min(10000, Math.max(360, Math.floor(requested))) : 360;
    const examples = createBlocksViewFixture(size);
    for (const block of examples) blocksMap.set(block.id, block);
    notifyClients({ type: 'reload' });
    res.json({ count: examples.length, testMode: true });
});

app.post("/api/test/reset", (_req, res) => {
    if (!isTestMode) return res.status(404).json({ error: "Not found" });
    blocksMap.clear();
    blockIdToFileMap.clear();
    pendingBlockLabels.clear();
    testAssets.clear();
    testRecoveryDrafts.clear();
    testSettings = null;
    testWorkspaceSession = null;
    for (const block of INITIAL_BLOCKS) {
        blocksMap.set(block.id, { ...block, references: computeReferences(block.content) });
    }
    res.json({ success: true });
});

app.post("/api/test/duplicate-labels", (req, res) => {
    if (!isTestMode) return res.status(404).json({ error: "Not found" });
    const label = normalizeBlockLabel(metadataText(req.body.label, `duplicate-${Date.now()}`));
    const blocks = ["A", "B"].map(suffix => ({
        id: uuidv4(),
        title: `Duplicate ${suffix}`,
        label,
        content: `Duplicate ${suffix} content`,
        references: [] as string[],
        hasContent: true
    }));
    for (const block of blocks) blocksMap.set(block.id, block);
    res.json(blocks.map(blockMetadata));
});

function notifyClients(message: any) {
    sseClients.forEach(client => {
        try {
            client.write(`data: ${JSON.stringify(message)}\n\n`);
        } catch (e) { }
    });
}

function blockRevision(block: Pick<BlockData, 'title' | 'label' | 'content'>): string {
    return crypto.createHash('sha256').update(JSON.stringify([block.title, block.label, block.content || ''])).digest('hex');
}

function rejectWorkspaceSymlinks(target: string) {
    const relative = path.relative(WORKSPACE_DIR, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path leaves the workspace');
    let current = WORKSPACE_DIR;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            if (fsSync.lstatSync(current).isSymbolicLink()) throw new Error('Workspace symlinks are not supported');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
            throw error;
        }
    }
}

async function ensureDir(dir: string) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (e) {}
}

function workspaceBackupPath(targetPath: string) {
    rejectWorkspaceSymlinks(targetPath);
    const relativePath = path.relative(WORKSPACE_DIR, path.resolve(targetPath));
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error(`Cannot back up a file outside the workspace: ${targetPath}`);
    }
    const backupPath = path.join(BACKUP_DIR, `${relativePath}.bak`);
    rejectWorkspaceSymlinks(backupPath);
    return backupPath;
}

function writeWorkspaceFile(targetPath: string, contents: string | Buffer) {
    rejectWorkspaceSymlinks(targetPath);
    return atomicWriteFile(targetPath, contents, { backupPath: workspaceBackupPath(targetPath) });
}

function backupWorkspaceFile(targetPath: string) {
    rejectWorkspaceSymlinks(targetPath);
    return backupFile(targetPath, workspaceBackupPath(targetPath));
}

async function migrateLegacyBackups(directory = WORKSPACE_DIR) {
    if (isTestMode || !fsSync.existsSync(directory)) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entryPath !== BACKUP_DIR) await migrateLegacyBackups(entryPath);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".bak")) continue;
        const originalPath = entryPath.slice(0, -4);
        const destinationPath = workspaceBackupPath(originalPath);
        let shouldCopy = true;
        try {
            const [sourceStats, destinationStats] = await Promise.all([fs.stat(entryPath), fs.stat(destinationPath)]);
            shouldCopy = sourceStats.mtimeMs > destinationStats.mtimeMs;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (shouldCopy) await atomicWriteFile(destinationPath, await fs.readFile(entryPath), { backup: false });
        await fs.unlink(entryPath);
    }
}

function safeWorkspaceRelativePath(value: unknown) {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) throw new Error('Invalid workspace path');
    const target = path.resolve(WORKSPACE_DIR, ...parts);
    if (!target.startsWith(`${WORKSPACE_DIR}${path.sep}`)) throw new Error('Invalid workspace path');
    rejectWorkspaceSymlinks(target);
    return { normalized: parts.join('/'), target };
}

async function listBackupFiles(directory = BACKUP_DIR, prefix = ''): Promise<Array<{ path: string, modifiedAt: number, size: number }>> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const results: Array<{ path: string, modifiedAt: number, size: number }> = [];
    for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) results.push(...await listBackupFiles(entryPath, relative));
        else if (entry.isFile() && entry.name.endsWith('.bak')) {
            const stats = await fs.stat(entryPath);
            results.push({ path: relative.slice(0, -4), modifiedAt: stats.mtimeMs, size: stats.size });
        }
    }
    return results;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}

const INITIAL_BLOCKS = [
    {
        id: uuidv4(),
        title: 'Welcome to Math Note Editor',
        label: 'showcase:main',
        content: [
            "Welcome to **Math Note Editor**. This is an example note: click this sentence and type. Your edits save automatically.",
            "",
            "Markdown like syntax are also supported: ",
            "* **Bold**",
            "* *Italic*",
            "* _underline_",
            "> You may also use > at the start.",
            "",
            "**Start here**",
            "1. Click **+** in the upright corner inside the toolbar to create a note. Its *title* is for reading; its *label* is its link address. Double-click the heading or press **F2** to edit the title and label of the root block of current tab. Each block is saved as a markdown file in the workspace folder.",
            "2. Click **Search** (shortcut **Cmd/Ctrl+K**) to find a note. To link one while writing, type two opening square brackets and an autocomplete will popup.",
            "3. This embedded note starts open. Click its title to close and reopen it; click its content to edit that note without leaving this page:",
            "[[showcase:embed-1∨]]",
            "",
            "**Try next:** [[showcase:math || Math]], [[showcase:embed-2 || Nested notes]], [[showcase:aliases || Links]], [[showcase:discover || Finding connections]], and [[showcase:features || Images & workspace∨]]."
        ].join('\n'),
    },
    {
        id: uuidv4(),
        title: 'An embedded note you can edit',
        label: 'showcase:embed-1',
        content: "This text belongs to a separate note. Click here and type something; the change stays with this note even if you close and reopen it.\n\nTry ↑ and ↓ to move across its boundary. With the caret on its title, **Enter** toggles it and **Cmd/Ctrl+Enter** opens it in a tab.",
    },
    {
        id: uuidv4(),
        title: 'A standout note with a child',
        label: 'showcase:embed-2',
        content: "This large title is a *standout embed*: it opens the same way as the smaller linked title above. Notes can also nest. Click the child title in this sentence and watch where **after** moves: before [[/child]] after.\n\nTry ↑/↓ across the visible rows, or ←/→ across a title's edges. The child's short **/child** link means **showcase:embed-2/child** inside this note.",
    },
    {
        id: uuidv4(),
        title: 'A child note',
        label: 'showcase:embed-2/child',
        content: "You are editing a note inside another note. Type here, then close and reopen the child; your change remains. With the caret on its title, **Cmd/Ctrl+Enter** opens it in a tab.",
    },
    {
        id: uuidv4(),
        title: 'Write mathematics',
        label: 'showcase:math',
        content: "**Inline math** sits in a sentence, like $x^2+y^2=1$. Click it to see the dollar signs around its source.\n\n**Display math** gets a row of its own. Click the equation below to reveal its source and the backslash-bracket markers around it:\n\\[\na^2+b^2=c^2\n\\]\nChange a number and move the caret away to see it render. You can mix math with **bold** and *italic* text.",
    },
    {
        id: uuidv4(),
        title: 'Link and organize notes',
        label: 'showcase:aliases',
        content: "Click [[showcase:math || these formulas]]. The words you see are an alias; the link still points to **showcase:math**.\n\nTo make your own link, click the end of this note, type two opening square brackets, and choose an autocomplete result. Type a new label and choose **Create new block** to make a note. A title is what people read; a label is the link address. Double-click a note heading or press **F2** to rename it (on some Macs, **Fn+F2**)."
    },
    {
        id: uuidv4(),
        title: 'Find connections between notes',
        label: 'showcase:discover',
        content: "Open [[showcase:math || the math note]], then click the **backlinks count** beside its heading to find notes that link to it.\n\nTry **Search** (**Cmd/Ctrl+K**) for a title or label. The toolbar's **Blocks View** shows the note hierarchy and issues; **Graph View** shows connections. **View Raw Markdown** beside a heading shows what is saved in that note's file."
    },
    {
        id: uuidv4(),
        title: 'Images and workspace',
        label: 'showcase:features',
        content: "Click in this note and press **Cmd/Ctrl+I**. The image picker lets you add an image or choose one from the assets folder; you can set its name, width, and description before inserting it. Cancel if you are only exploring.\n\nTry **Settings → General Setting → Manage Assets** to browse images; renaming or moving one there updates its references. Notes are Markdown files in your workspace, and images live in its assets folder. Settings also contains **Backup Recovery**, shortcuts, math macros, and autocomplete."
    }
];

const blockIdToFileMap = new Map<string, string>();
const pendingBlockLabels = new Set<string>();
const blockWriteQueues = new Map<string, Promise<void>>();
let relabelInProgress = false;

function relabelRevision(blocks: BlockData[]) {
    const snapshot = blocks
        .map(block => ({ id: block.id, title: block.title, label: block.label, content: block.content || "" }))
        .sort((left, right) => left.id.localeCompare(right.id));
    return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function createRelabelPlan(oldPrefixInput: unknown, newPrefixInput: unknown): Promise<{ plan: SafeRelabelPlan, blocks: BlockData[], loadedBefore: Set<string> }> {
    const oldPrefix = normalizeBlockLabel(metadataText(oldPrefixInput));
    const newPrefix = normalizeBlockLabel(metadataText(newPrefixInput));
    const loadedBefore = new Set(
        Array.from(blocksMap.entries())
            .filter(([, block]) => block.content !== undefined)
            .map(([id]) => id)
    );
    await mapWithConcurrency(Array.from(blocksMap.keys()), 16, ensureBlockContent);
    const blocks = Array.from(blocksMap.values()).filter((block): block is BlockData & { content: string } => block.content !== undefined);
    const plan = buildSafeRelabelPlan(blocks, oldPrefix, newPrefix);
    plan.revision = relabelRevision(blocks);
    plan.signature = crypto.createHash("sha256").update(relabelPlanSignatureInput(plan)).digest("hex");
    for (const change of plan.blockChanges) change.fileName = blockIdToFileMap.get(change.id);
    for (const impact of plan.referenceImpacts) impact.fileName = blockIdToFileMap.get(impact.blockId);
    return { plan, blocks, loadedBefore };
}

function restoreLazyBlockBodies(loadedBefore: Set<string>) {
    if (isTestMode) return;
    for (const [id, block] of blocksMap) {
        if (!loadedBefore.has(id) && block.content !== undefined) blocksMap.set(id, blockMetadata(block));
    }
}

async function writeRelabelTransaction(updatedBlocks: BlockData[]) {
    if (isTestMode) return;
    const originalFileMap = new Map(blockIdToFileMap);
    const snapshots = new Map<string, string>();
    for (const block of updatedBlocks) {
        const filename = originalFileMap.get(block.id);
        if (filename) snapshots.set(block.id, await fs.readFile(path.join(BLOCKS_DIR, filename), "utf-8"));
    }
    try {
        for (const block of updatedBlocks) await writeBlockToFile(block);
    } catch (error) {
        for (const block of updatedBlocks) {
            const originalFilename = originalFileMap.get(block.id);
            const currentFilename = blockIdToFileMap.get(block.id);
            if (currentFilename && currentFilename !== originalFilename) {
                await fs.unlink(path.join(BLOCKS_DIR, currentFilename)).catch(() => {});
            }
            const snapshot = snapshots.get(block.id);
            if (originalFilename && snapshot !== undefined) {
                await ensureDir(path.dirname(path.join(BLOCKS_DIR, originalFilename)));
                await atomicWriteFile(path.join(BLOCKS_DIR, originalFilename), snapshot, { backup: false });
            }
        }
        blockIdToFileMap.clear();
        for (const [id, filename] of originalFileMap) blockIdToFileMap.set(id, filename);
        throw error;
    }
}

async function writeBlockToFileUnlocked(block: BlockData) {
    if (isTestMode) return;
    // The path is assigned once. A Finder rename is discovered by the watcher
    // and becomes the new path; editing title or label never renames it.
    const filename = blockIdToFileMap.get(block.id) || makeInitialBlockFilename(block.title || '', block.id);
    const filePath = path.join(BLOCKS_DIR, filename);
    rejectWorkspaceSymlinks(filePath);
    if (!blockIdToFileMap.has(block.id) && fsSync.existsSync(filePath)) {
        throw new Error(`Note filename "${filename}" is already in use`);
    }
    const fileContent = stringifyFrontmatter({
        id: block.id,
        title: block.title || "",
        label: block.label || ""
    }, block.content || "");
    
    await ensureDir(path.dirname(filePath));
    await writeWorkspaceFile(filePath, fileContent);
    blockIdToFileMap.set(block.id, filename);
}

async function writeBlockToFile(block: BlockData) {
    return withBlockWriteLock(block.id, () => writeBlockToFileUnlocked(block));
}

async function withBlockWriteLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = blockWriteQueues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const queued = current.then(() => {}, () => {});
    blockWriteQueues.set(id, queued);
    try {
        return await current;
    } finally {
        if (blockWriteQueues.get(id) === queued) blockWriteQueues.delete(id);
    }
}

function blockMetadata(block: BlockData) {
    return {
        id: block.id,
        title: block.title,
        label: block.label,
        references: block.references || [],
        hasContent: block.hasContent ?? (block.content !== undefined && block.content.trim().length > 0),
        revision: block.revision || blockRevision(block),
        _fileMeta: { fileName: blockIdToFileMap.get(block.id) }
    };
}

async function ensureBlockContent(id: string): Promise<BlockData | null> {
    const cached = blocksMap.get(id);
    if (!cached) return null;
    if (cached.content !== undefined) return cached;

    const filename = blockIdToFileMap.get(id);
    if (!filename) return cached;
    rejectWorkspaceSymlinks(path.join(BLOCKS_DIR, filename));
    const fileText = await fs.readFile(path.join(BLOCKS_DIR, filename), "utf-8");
    const parsed = parseFrontmatter(fileText);
    const fullBlock: BlockData = {
        ...cached,
        title: normalizeBlockTitle(metadataText(parsed.data.title, cached.title)),
        label: normalizeBlockLabel(metadataText(parsed.data.label, cached.label)),
        references: computeReferences(parsed.content),
        content: parsed.content,
        hasContent: parsed.content.trim().length > 0
    };
    fullBlock.revision = blockRevision(fullBlock);
    blocksMap.set(id, fullBlock);
    return fullBlock;
}

async function readCurrentBlock(id: string): Promise<BlockData | null> {
    if (isTestMode) {
        const block = await ensureBlockContent(id);
        return block ? { ...block, revision: blockRevision(block) } : null;
    }
    const filename = blockIdToFileMap.get(id);
    if (!filename) return null;
    const filePath = path.join(BLOCKS_DIR, filename);
    rejectWorkspaceSymlinks(filePath);
    const parsed = parseFrontmatter(await fs.readFile(filePath, 'utf-8'));
    if (metadataText(parsed.data.id) !== id) throw new Error('Note identity changed on disk');
    const block: BlockData = {
        id,
        title: normalizeBlockTitle(metadataText(parsed.data.title)),
        label: normalizeBlockLabel(metadataText(parsed.data.label)),
        content: parsed.content,
        hasContent: parsed.content.trim().length > 0,
        references: computeReferences(parsed.content)
    };
    block.revision = blockRevision(block);
    return block;
}

async function initBlocks() {
    blocksMap.clear();
    blockIdToFileMap.clear();
    if (!fsSync.existsSync(BLOCKS_DIR)) {
        if (isTestMode) {
            for (const block of INITIAL_BLOCKS) {
                blocksMap.set(block.id, { ...block, references: computeReferences(block.content) });
            }
            return;
        }
        await ensureDir(BLOCKS_DIR);
    }
    await migrateLegacyBackups();
    const files = await fs.readdir(BLOCKS_DIR, { recursive: true });
    if (files.filter(f => typeof f === 'string' && f.endsWith(".md")).length === 0) {
        for (const block of INITIAL_BLOCKS) {
            const blockWithReferences = { ...block, references: computeReferences(block.content) };
            await writeBlockToFile(blockWithReferences);
            blocksMap.set(block.id, blockWithReferences);
        }
    } else {
        const mdFiles = files.filter(f => typeof f === 'string' && f.endsWith(".md")) as string[];
        const metadataEntries = await mapWithConcurrency(mdFiles, 16, async file => {
            const filePath = path.join(BLOCKS_DIR, file);
            try { rejectWorkspaceSymlinks(filePath); }
            catch (error) {
                console.warn(`Skipping unsafe note path "${file}": ${error}`);
                return null;
            }
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = parseFrontmatter(content);
            const id = metadataText(parsed.data.id, path.basename(file, ".md"));
            return {
                file,
                block: {
                    id,
                    title: normalizeBlockTitle(metadataText(parsed.data.title)),
                    label: normalizeBlockLabel(metadataText(parsed.data.label)),
                    references: computeReferences(parsed.content),
                    hasContent: parsed.content.trim().length > 0,
                    revision: blockRevision({
                        title: normalizeBlockTitle(metadataText(parsed.data.title)),
                        label: normalizeBlockLabel(metadataText(parsed.data.label)),
                        content: parsed.content
                    })
                } satisfies BlockData
            };
        });
        for (const { file, block } of metadataEntries.filter((entry): entry is NonNullable<typeof entry> => !!entry)) {
            const id = block.id;
            const normalizedFile = file.replace(/\\/g, '/');
            const existingFilename = blockIdToFileMap.get(id);
            // A filesystem watcher can refresh this same file while a full
            // workspace reload is in progress (notably during backup restore).
            // Only a different path represents a genuine duplicate id.
            if (existingFilename && existingFilename !== normalizedFile) {
                // Keep the second note and its content; only its duplicate ID
                // changes. The original file is backed up before repair.
                const newId = uuidv4();
                const filePath = path.join(BLOCKS_DIR, normalizedFile);
                const original = parseFrontmatter(await fs.readFile(filePath, 'utf-8'));
                await writeWorkspaceFile(filePath, stringifyFrontmatter({ ...original.data, id: newId }, original.content));
                block.id = newId;
                console.warn(`Reassigned duplicate note ID in "${file}"; original copy is in workspace backups.`);
            }
            blocksMap.set(block.id, block);
            // Normalize path slashes for consistency across platforms (use forward slash in map)
            blockIdToFileMap.set(block.id, normalizedFile);
        }
    }
}

app.post("/api/assets", express.json({limit: '20mb'}), async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: 'A workspace transformation is currently running' });
        const { filePath, content, overwrite } = req.body;
        const { normalized, target: absolutePath } = safeWorkspaceRelativePath(filePath);
        if (!normalized.startsWith('assets/') || normalized === 'assets') return res.status(400).json({error: "Invalid asset path"});
        const assetPath = normalized.slice('assets/'.length);
        const pathError = validateAssetPath(assetPath);
        if (pathError) return res.status(400).json({ error: pathError });
        const dataUri = typeof content === 'string' ? content.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/) : null;
        if (!dataUri) return res.status(400).json({ error: 'Invalid asset content' });
        const contentType = dataUri[1].toLowerCase();
        const base64Data = dataUri[2];
        const buffer = Buffer.from(base64Data, 'base64');
        const imageError = validateImageUpload({ type: contentType, size: buffer.length }, 'server');
        if (imageError) return res.status(400).json({ error: imageError });
        const nameError = validateImageFilename(assetPath, contentType);
        if (nameError) return res.status(400).json({ error: nameError });
        if (!imageSignatureMatches(buffer, contentType)) return res.status(400).json({ error: 'The file does not match its image format.' });
        await withAssetWriteLock(assetPath, async () => {
            if (overwrite !== true && (testAssets.has(assetPath) || fsSync.existsSync(absolutePath))) {
                return res.status(409).json({ error: 'An image with this name already exists. Choose Replace or rename it.' });
            }
            if (isTestMode) {
                testAssets.set(assetPath, { buffer, contentType });
                return res.json({ success: true, url: `assets/${assetPath}` });
            }
            await ensureDir(path.dirname(absolutePath));
            await writeWorkspaceFile(absolutePath, buffer);
            return res.json({ success: true, url: `assets/${assetPath}` });
        });
    } catch (e) {
        res.status(400).json({ error: String(e) });
    }
});

async function listWorkspaceAssets(): Promise<string[]> {
        const assetsPath = path.join(BLOCKS_DIR, "assets");
        if (!isTestMode) await ensureDir(assetsPath);
        const files: string[] = Array.from(testAssets.keys());
        async function scanDir(dir: string, base: string) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    await scanDir(path.join(dir, entry.name), path.join(base, entry.name));
                } else {
                    files.push(path.join(base, entry.name).replace(/\\/g, '/'));
                }
            }
        }
        if (fsSync.existsSync(assetsPath)) await scanDir(assetsPath, "");
        return files.map(file => `assets/${file}`);
}

app.get("/api/assets-list", async (_req, res) => {
    try {
        res.json((await listWorkspaceAssets()).map(file => file.slice('assets/'.length)));
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

async function createAssetMovePlan(sourceInput: string, destinationInput: string) {
    const source = `assets/${String(sourceInput).replace(/^assets\//, '')}`;
    const { target } = safeWorkspaceRelativePath(source);
    const testAsset = testAssets.get(source.slice('assets/'.length));
    const bytes = testAsset?.buffer || await fs.readFile(target).catch(() => null);
    const sourceVersion = bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : '';
    const loadedBefore = new Set(Array.from(blocksMap.entries()).filter(([, block]) => block.content !== undefined).map(([id]) => id));
    await mapWithConcurrency(Array.from(blocksMap.keys()), 16, ensureBlockContent);
    const blocks = Array.from(blocksMap.values()).filter((block): block is BlockData & { content: string } => block.content !== undefined);
    const assets = await listWorkspaceAssets();
    const plan = buildAssetMovePlan(blocks, assets, sourceInput, destinationInput, sourceVersion);
    for (const impact of plan.impacts) impact.fileName = blockIdToFileMap.get(impact.blockId);
    plan.revision = crypto.createHash('sha256').update(assetMoveRevisionInput(blocks, assets, plan)).digest('hex');
    return { plan, blocks, loadedBefore, bytes, testAsset };
}

app.post('/api/assets/move/preview', async (req, res) => {
    let loadedBefore: Set<string> | null = null;
    try {
        if (relabelInProgress) return res.status(409).json({ error: 'Another workspace transformation is running' });
        const prepared = await createAssetMovePlan(req.body?.source, req.body?.destination);
        loadedBefore = prepared.loadedBefore;
        res.json(prepared.plan);
    } catch (error) { res.status(400).json({ error: String(error) }); }
    finally { if (loadedBefore) restoreLazyBlockBodies(loadedBefore); }
});

app.post('/api/assets/move/commit', async (req, res) => {
    if (relabelInProgress) return res.status(409).json({ error: 'Another workspace transformation is running' });
    relabelInProgress = true;
    let loadedBefore: Set<string> | null = null;
    try {
        const prepared = await createAssetMovePlan(req.body?.source, req.body?.destination);
        const { plan, blocks, bytes, testAsset } = prepared;
        loadedBefore = prepared.loadedBefore;
        if (plan.conflicts.length) return res.status(409).json({ error: plan.conflicts.join(' '), plan });
        if (!req.body?.revision || req.body.revision !== plan.revision) {
            return res.status(409).json({ error: 'The workspace or image changed. Review the move again.', plan });
        }
        if (!bytes) throw new Error('The source image is missing.');
        const sourceTarget = safeWorkspaceRelativePath(plan.source).target;
        const destinationTarget = safeWorkspaceRelativePath(plan.destination).target;
        if (testAsset) testAssets.set(plan.destination.slice('assets/'.length), testAsset);
        else {
            await ensureDir(path.dirname(destinationTarget));
            await fs.writeFile(destinationTarget, bytes, { flag: 'wx' });
        }
        const updatedBlocks = blocks.flatMap(block => {
            const result = replaceAssetImageReferences(block.content || '', plan.source, plan.destination);
            return result.references.length ? [{ ...block, content: result.content,
                references: computeReferences(result.content), hasContent: result.content.trim().length > 0 }] : [];
        });
        // Copy first. If writing a note fails, both image paths remain available.
        await writeRelabelTransaction(updatedBlocks);
        for (const block of updatedBlocks) block.revision = blockRevision(block);
        for (const block of updatedBlocks) blocksMap.set(block.id, block);
        for (const block of updatedBlocks) notifyClients({ type: 'update', block });
        let warning: string | undefined;
        try {
            if (testAsset) testAssets.delete(plan.source.slice('assets/'.length));
            else { await backupWorkspaceFile(sourceTarget); await fs.unlink(sourceTarget); }
        } catch { warning = 'The notes now use the new image, but the original could not be removed. Both copies remain; remove the old one after checking the workspace.'; }
        res.json({ plan, updatedBlocks, warning });
    } catch (error) {
        notifyClients({ type: 'reload' });
        res.status(500).json({ error: String(error) });
    } finally {
        if (loadedBefore) restoreLazyBlockBodies(loadedBefore);
        relabelInProgress = false;
    }
});

app.get(/^\/api\/assets\/(.+)$/, async (req, res) => {
    try {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', 'sandbox');
        const { normalized, target: absolutePath } = safeWorkspaceRelativePath(`assets/${req.params[0]}`);
        if (!normalized.startsWith('assets/')) return res.status(400).json({ error: 'Invalid asset path' });
        const assetPath = normalized.slice('assets/'.length);
        const testAsset = testAssets.get(assetPath);
        if (testAsset) {
            res.type(testAsset.contentType);
            return res.send(testAsset.buffer);
        }
        res.sendFile(absolutePath);
    } catch (e) {
        res.status(400).json({ error: String(e) });
    }
});

app.get("/api/blocks", async (req, res) => {
    try {
        const blocks = Array.from(blocksMap.values()).map(blockMetadata);
        // Sort by title
        blocks.sort((a, b) => a.title.localeCompare(b.title));
        
        if (req.query.metaOnly === 'true') {
            res.json(blocks);
        } else {
            const fullBlocks = (await Promise.all(blocks.map(block => ensureBlockContent(block.id))))
                .filter((block): block is BlockData => !!block)
                .sort((a, b) => a.title.localeCompare(b.title));
            res.json(fullBlocks);
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/blocks/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const block = await readCurrentBlock(id);
        if (block) {
            res.json(block);
        } else {
            res.status(404).json({ error: "File not found" });
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/settings", async (req, res) => {
    try {
        const settingDir = path.join(WORKSPACE_DIR, "setting");
        const settingsPath = path.join(settingDir, "settings.json");
        rejectWorkspaceSymlinks(settingsPath);
        const content = await fs.readFile(settingsPath, "utf-8").catch(() => "{\"macros\":{},\"customCommands\":[],\"textCommands\":[]}");
        if (isTestMode) {
            if (!testSettings) {
                testSettings = JSON.parse(content);
                delete testSettings.workspaceSession;
            }
            return res.json(testWorkspaceSession ? { ...testSettings, workspaceSession: testWorkspaceSession } : testSettings);
        }
        await ensureDir(settingDir);
        res.json(JSON.parse(content));
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

function recoveryPath(id: string) {
    if (!id || id.length > 256) throw new Error('Invalid note ID');
    const target = path.join(RECOVERY_DIR, `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
    rejectWorkspaceSymlinks(target);
    return target;
}

app.get('/api/recovery', async (_req, res) => {
    try {
        if (isTestMode) return res.json({ drafts: Array.from(testRecoveryDrafts.values()), errors: [] });
        rejectWorkspaceSymlinks(RECOVERY_DIR);
        const files = await fs.readdir(RECOVERY_DIR).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        });
        const drafts: Record<string, unknown>[] = [];
        const errors: string[] = [];
        for (const file of files.filter(name => name.endsWith('.json'))) {
            try {
                const target = path.join(RECOVERY_DIR, file);
                rejectWorkspaceSymlinks(target);
                const draft = JSON.parse(await fs.readFile(target, 'utf-8'));
                if (typeof draft.id !== 'string' || recoveryPath(draft.id) !== target) throw new Error('Invalid recovery record');
                drafts.push(draft);
            } catch (error) { errors.push(`${file}: ${String(error)}`); }
        }
        res.json({ drafts, errors });
    } catch (error) { res.status(500).json({ error: String(error) }); }
});

app.put('/api/recovery/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const draft = req.body;
        if (draft?.id !== id || typeof draft.title !== 'string' || typeof draft.label !== 'string' ||
            (draft.content !== undefined && typeof draft.content !== 'string') ||
            (draft.baseRevision !== undefined && typeof draft.baseRevision !== 'string') ||
            typeof draft.updatedAt !== 'number' || !Number.isFinite(draft.updatedAt)) {
            return res.status(400).json({ error: 'Invalid recovery draft' });
        }
        const record = { id, title: draft.title, label: draft.label, content: draft.content,
            baseRevision: draft.baseRevision, updatedAt: draft.updatedAt };
        await withBlockWriteLock(id, async () => {
            if (isTestMode) {
                const previous = testRecoveryDrafts.get(id);
                if (!previous || Number(previous.updatedAt) <= record.updatedAt) testRecoveryDrafts.set(id, record);
            } else {
                await ensureDir(RECOVERY_DIR);
                const target = recoveryPath(id);
                const previous = await fs.readFile(target, 'utf-8').then(text => JSON.parse(text) as { updatedAt?: number }).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                    throw error;
                });
                if (previous && Number(previous.updatedAt) > record.updatedAt) return;
                await atomicWriteFile(target, JSON.stringify(record), { backup: false });
            }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: String(error) }); }
});

app.delete('/api/recovery/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '');
        await withBlockWriteLock(id, async () => {
            if (isTestMode) testRecoveryDrafts.delete(id);
            else await fs.unlink(recoveryPath(id)).catch(error => {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            });
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: String(error) }); }
});

app.post("/api/settings", async (req, res) => {
    try {
        const issues = validateEditorSettings(req.body);
        if (issues.length) return res.status(400).json({ error: issues.join(' ') });
        if (isTestMode) {
            testSettings = structuredClone(req.body || {});
            delete testSettings.workspaceSession;
            return res.json({ success: true });
        }
        const settingDir = path.join(WORKSPACE_DIR, "setting");
        await ensureDir(settingDir);
        const settingsPath = path.join(settingDir, "settings.json");
        await writeWorkspaceFile(settingsPath, JSON.stringify(req.body || {}, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/workspace/session', async (req, res) => {
    try {
        const openTabs = Array.isArray(req.body?.openTabs) ? req.body.openTabs.filter((id: unknown) => typeof id === 'string') : [];
        const activeTab = typeof req.body?.activeTab === 'string' && openTabs.includes(req.body.activeTab) ? req.body.activeTab : null;
        const lockedTabs = Array.isArray(req.body?.lockedTabs) ? req.body.lockedTabs.filter((id: unknown) => typeof id === 'string') : [];
        if (isTestMode) {
            if (req.body?.persistForTest === true) testWorkspaceSession = { openTabs, activeTab, lockedTabs };
            return res.json({ success: true });
        }
        const settingsPath = path.join(WORKSPACE_DIR, 'setting', 'settings.json');
        const current = JSON.parse(await fs.readFile(settingsPath, 'utf8').catch(() => '{}'));
        await ensureDir(path.dirname(settingsPath));
        await writeWorkspaceFile(settingsPath, JSON.stringify({ ...current, workspaceSession: { openTabs, activeTab, lockedTabs } }, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/backups', async (_req, res) => {
    try {
        if (isTestMode) return res.json([]);
        res.json((await listBackupFiles()).sort((a, b) => b.modifiedAt - a.modifiedAt));
    } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/backups/restore', async (req, res) => {
    try {
        if (isTestMode) return res.status(403).json({ error: 'Backup restore is disabled in test mode' });
        const { normalized, target } = safeWorkspaceRelativePath(req.body?.path);
        const backupPath = path.join(BACKUP_DIR, `${normalized}.bak`);
        const backupContents = await fs.readFile(backupPath);
        const currentContents = await fs.readFile(target).catch(() => null);
        await ensureDir(path.dirname(target));
        await atomicWriteFile(target, backupContents, { backup: false });
        if (currentContents) await atomicWriteFile(backupPath, currentContents, { backup: false });
        await initBlocks();
        notifyClients({ type: 'reload' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/workspace/duplicate-labels/:id/resolve", async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: "A tree transformation is currently running" });
        const id = req.params.id;
        const existing = await ensureBlockContent(id);
        if (!existing) return res.status(404).json({ error: "Block not found" });
        const duplicateCount = Array.from(blocksMap.values())
            .filter(block => normalizeBlockLabel(block.label) === existing.label).length;
        if (duplicateCount < 2) {
            return res.status(409).json({ error: `Label "${existing.label}" is no longer duplicated` });
        }
        const newLabel = normalizeBlockLabel(metadataText(req.body.newLabel));
        const labelError = validateBlockLabel(newLabel);
        if (labelError) return res.status(400).json({ error: labelError });
        if (Array.from(blocksMap.values()).some(block => block.id !== id && normalizeBlockLabel(block.label) === newLabel)) {
            return res.status(409).json({ error: `Label "${newLabel}" already exists` });
        }
        const updated: BlockData = {
            ...existing,
            label: newLabel,
            references: computeReferences(existing.content || ""),
            hasContent: (existing.content || "").trim().length > 0
        };
        await writeBlockToFile(updated);
        updated.revision = blockRevision(updated);
        blocksMap.set(id, updated);
        notifyClients({ type: "update", block: updated });
        res.json(blockMetadata(updated));
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post("/api/workspace/duplicate-labels/:id/undo-resolve", async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: "A tree transformation is currently running" });
        const existing = await ensureBlockContent(req.params.id);
        const currentLabel = normalizeBlockLabel(metadataText(req.body.currentLabel));
        const oldLabel = normalizeBlockLabel(metadataText(req.body.oldLabel));
        if (!existing || existing.label !== currentLabel ||
            !Array.from(blocksMap.values()).some(block => block.id !== existing.id && normalizeBlockLabel(block.label) === oldLabel)) {
            return res.status(409).json({ error: "The duplicate label repair changed since it was recorded" });
        }
        const updated: BlockData = { ...existing, label: oldLabel };
        await writeBlockToFile(updated);
        updated.revision = blockRevision(updated);
        blocksMap.set(updated.id, updated);
        notifyClients({ type: "update", block: updated });
        res.json(blockMetadata(updated));
    } catch (error) { res.status(500).json({ error: String(error) }); }
});

app.post("/api/relabel/preview", async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: "Another tree transformation is currently running" });
        const { plan, loadedBefore } = await createRelabelPlan(req.body.oldPrefix, req.body.newPrefix);
        restoreLazyBlockBodies(loadedBefore);
        res.json(plan);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post("/api/relabel/commit", async (req, res) => {
    if (relabelInProgress) return res.status(409).json({ error: "Another tree transformation is currently running" });
    relabelInProgress = true;
    let loadedBefore: Set<string> | null = null;
    try {
        const prepared = await createRelabelPlan(req.body.oldPrefix, req.body.newPrefix);
        const { plan, blocks } = prepared;
        loadedBefore = prepared.loadedBefore;
        if (plan.conflicts.length) return res.status(409).json({ error: plan.conflicts.join(" "), plan });
        const revisionChanged = !req.body.revision || req.body.revision !== plan.revision;
        const semanticPlanChanged = !req.body.signature || req.body.signature !== plan.signature;
        if (revisionChanged && semanticPlanChanged) {
            return res.status(409).json({
                error: "The workspace changed after this preview. Review the refreshed transformation before confirming.",
                plan
            });
        }
        const planned = applySafeRelabelPlan(blocks, plan);
        const updatedBlocks: BlockData[] = [];
        for (let index = 0; index < blocks.length; index++) {
            const before = blocks[index];
            const after = planned[index];
            if (before.label === after.label && before.content === after.content) continue;
            updatedBlocks.push({
                ...before,
                label: after.label,
                content: after.content,
                references: computeReferences(after.content || ""),
                hasContent: (after.content || "").trim().length > 0
            });
        }
        await writeRelabelTransaction(updatedBlocks);
        for (const block of updatedBlocks) block.revision = blockRevision(block);
        for (const block of updatedBlocks) blocksMap.set(block.id, block);
        for (const block of updatedBlocks) notifyClients({ type: "update", block });
        res.json({ plan, updatedBlocks });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    } finally {
        if (loadedBefore) restoreLazyBlockBodies(loadedBefore);
        relabelInProgress = false;
    }
});

app.post("/api/blocks", async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: "A tree transformation is currently running" });
        const id = uuidv4();
        const title = normalizeBlockTitle(metadataText(req.body.title, "New Block"));
        const label = normalizeBlockLabel(metadataText(req.body.label, "block"));
        const metadataError = validateBlockMetadata(title, label);
        if (metadataError) return res.status(400).json({ error: metadataError });
        if (pendingBlockLabels.has(label) || Array.from(blocksMap.values()).some(candidate => candidate.label === label)) {
            return res.status(409).json({ error: `Label "${label}" already exists` });
        }
        pendingBlockLabels.add(label);
        try {
            const block: BlockData = {
                id,
                title,
                label,
                content: req.body.content || "",
                hasContent: !!req.body.content
            };
            block.references = computeReferences(block.content || "");
            await writeBlockToFile(block);
            block.revision = blockRevision(block);
            blocksMap.set(block.id, block);
            notifyClients({ type: 'update', block });
            res.json(block);
        } finally {
            pendingBlockLabels.delete(label);
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Undo of a deletion must restore the original identity so existing embedded
// references and open tabs still point at the same note.
app.post("/api/blocks/restore", async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: "A tree transformation is currently running" });
        const id = req.body?.id;
        if (typeof id !== "string" || !id || id.length > 256) {
            return res.status(400).json({ error: "A valid note ID is required" });
        }
        const title = normalizeBlockTitle(metadataText(req.body.title));
        const label = normalizeBlockLabel(metadataText(req.body.label));
        const content = req.body.content;
        const metadataError = validateBlockMetadata(title, label);
        if (metadataError || typeof content !== "string") {
            return res.status(400).json({ error: metadataError || "Note content is required" });
        }
        if (blocksMap.has(id) || blockIdToFileMap.has(id)) {
            return res.status(409).json({ error: `Note ID "${id}" already exists` });
        }
        if (pendingBlockLabels.has(label) || Array.from(blocksMap.values()).some(candidate => candidate.label === label)) {
            return res.status(409).json({ error: `Label "${label}" already exists` });
        }
        pendingBlockLabels.add(label);
        try {
            const block: BlockData = {
                id, title, label, content,
                hasContent: content.trim().length > 0,
                references: computeReferences(content)
            };
            await writeBlockToFile(block);
            block.revision = blockRevision(block);
            blocksMap.set(block.id, block);
            notifyClients({ type: 'update', block });
            res.json(block);
        } finally {
            pendingBlockLabels.delete(label);
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.put("/api/blocks/:id", async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: "A tree transformation is currently running" });
        const id = req.params.id;
        await withBlockWriteLock(id, async () => {
        const existing = await readCurrentBlock(id);
        if (!existing) {
            return res.status(404).json({ error: "Block not found" });
        }
        const baseRevision = req.body?.baseRevision;
        if (typeof baseRevision !== 'string' && !isTestMode) return res.status(428).json({ error: 'Reload the note before saving; its base revision is missing.' });
        if (typeof baseRevision === 'string' && baseRevision !== existing.revision) {
            return res.status(409).json({ error: 'This note changed elsewhere. Your draft is still in the editor.', currentBlock: existing });
        }
        
        const newLabel = req.body.label !== undefined
            ? normalizeBlockLabel(metadataText(req.body.label))
            : existing.label;
        const newTitle = req.body.title !== undefined
            ? normalizeBlockTitle(metadataText(req.body.title))
            : existing.title;
        const metadataError = validateBlockTitle(newTitle) || validateBlockLabel(newLabel);
        if (metadataError) return res.status(400).json({ error: metadataError });
        if (newLabel !== existing.label) {
            return res.status(409).json({
                error: "Label changes require a reviewed tree transformation. Use /api/relabel/preview and /api/relabel/commit."
            });
        }
        if (req.body.content !== undefined && typeof req.body.content !== 'string') return res.status(400).json({ error: 'Note content must be text' });

        const block: BlockData = {
            id,
            title: newTitle,
            label: newLabel,
            content: req.body.content !== undefined ? req.body.content : existing.content,
            hasContent: (req.body.content !== undefined ? req.body.content : existing.content || "").trim().length > 0
        };
        block.references = computeReferences(block.content || "");
        await writeBlockToFileUnlocked(block);
        block.revision = blockRevision(block);
        blocksMap.set(id, block);
        notifyClients({ type: 'update', block });
        res.json({ block, updatedBlocks: [block] });
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/blocks/:id/raw", async (req, res) => {
    try {
        const id = req.params.id;
        const block = await ensureBlockContent(id);
        if (block) {
            res.setHeader('Content-Type', 'text/plain');
            res.send(block.content || "");
        } else {
            res.status(404).json({ error: "File not found" });
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.delete("/api/blocks/:id", async (req, res) => {
    try {
        if (relabelInProgress) return res.status(409).json({ error: "A tree transformation is currently running" });
        const id = req.params.id;
        await withBlockWriteLock(id, async () => {
        const existing = await readCurrentBlock(id);
        if (!existing) return res.status(404).json({ error: 'Block not found' });
        const baseRevision = req.body?.baseRevision;
        if (typeof baseRevision !== 'string' && !isTestMode) return res.status(428).json({ error: 'Reload the note before deleting; its base revision is missing.' });
        if (typeof baseRevision === 'string' && baseRevision !== existing.revision) {
            return res.status(409).json({ error: 'This note changed elsewhere. Delete was cancelled.', currentBlock: existing });
        }
        const filename = blockIdToFileMap.get(id);
        if (isTestMode) {
            blockIdToFileMap.delete(id);
        } else if (filename) {
            const filePath = path.join(BLOCKS_DIR, filename);
            await backupWorkspaceFile(filePath);
            rejectWorkspaceSymlinks(filePath);
            await fs.unlink(filePath);
            blockIdToFileMap.delete(id);
        } else {
            return res.status(404).json({ error: 'Note file not found' });
        }
        blocksMap.delete(id);
        notifyClients({ type: 'delete', id });
        res.json({ success: true });
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/events", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const keepAlive = setInterval(() => {
        try {
            res.write(':keepalive\n\n');
        } catch (e) {
            clearInterval(keepAlive);
        }
    }, 30000);

    sseClients.push(res);

    req.on('close', () => {
        clearInterval(keepAlive);
        sseClients = sseClients.filter(client => client !== res);
    });
});

async function startServer() {
    await initBlocks();

    if (!isTestMode && fsSync.existsSync(BLOCKS_DIR)) {
        fsSync.watch(BLOCKS_DIR, { recursive: true }, (eventType, changedFilename) => {
            const filename = changedFilename?.replace(/\\/g, '/');
            if (!filename || !filename.endsWith('.md')) return;
            
            setTimeout(async () => {
                const filePath = path.join(BLOCKS_DIR, filename);
                let content;
                try {
                    rejectWorkspaceSymlinks(filePath);
                    content = await fs.readFile(filePath, "utf-8");
                } catch (e) {
                    const id = Array.from(blockIdToFileMap.entries()).find(([k, v]) => v === filename)?.[0];
                    if (id && blocksMap.has(id)) {
                        // Finder may report the old name before the new name.
                        // Find its ID at the new path before announcing deletion.
                        const candidates = await fs.readdir(BLOCKS_DIR, { recursive: true });
                        for (const candidate of candidates) {
                            if (typeof candidate !== 'string' || !candidate.endsWith('.md') || candidate === filename) continue;
                            const candidatePath = path.join(BLOCKS_DIR, candidate);
                            try {
                                rejectWorkspaceSymlinks(candidatePath);
                                const parsedCandidate = parseFrontmatter(await fs.readFile(candidatePath, 'utf-8'));
                                if (metadataText(parsedCandidate.data.id) === id) {
                                    blockIdToFileMap.set(id, candidate.replace(/\\/g, '/'));
                                    return;
                                }
                            } catch { /* Ignore unreadable or unsafe candidates. */ }
                        }
                        blocksMap.delete(id);
                        blockIdToFileMap.delete(id);
                        notifyClients({ type: 'delete', id });
                    }
                    return;
                }

                const parsed = parseFrontmatter(content);
                const id = metadataText(parsed.data.id, filename.replace(".md", ""));
                const mappedFilename = blockIdToFileMap.get(id);
                if (mappedFilename && mappedFilename !== filename) {
                    // Some watchers report only the new path for an external
                    // rename. Check the old path on disk before treating the
                    // new path as a duplicate of the same note.
                    try {
                        const mappedPath = path.join(BLOCKS_DIR, mappedFilename);
                        rejectWorkspaceSymlinks(mappedPath);
                        const mappedText = await fs.readFile(mappedPath, 'utf-8');
                        const mappedId = metadataText(parseFrontmatter(mappedText).data.id, path.basename(mappedFilename, '.md'));
                        if (mappedId === id) {
                            console.error(`Ignoring duplicate block id "${id}" in "${filename}"; already loaded from "${mappedFilename}"`);
                            return;
                        }
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                            console.warn(`Could not verify the previous path for note "${id}": ${error}`);
                            return;
                        }
                    }
                }
                
                const existing = blocksMap.get(id);
                const parsedTitle = normalizeBlockTitle(metadataText(parsed.data.title));
                const parsedLabel = normalizeBlockLabel(metadataText(parsed.data.label));
                if (existing && existing.content === parsed.content && existing.title === parsedTitle && existing.label === parsedLabel) {
                    if (mappedFilename !== filename) blockIdToFileMap.set(id, filename);
                    return; // No change or our own update
                }

                const newBlock: BlockData = {
                    id,
                    title: parsedTitle,
                    label: parsedLabel,
                    references: computeReferences(parsed.content),
                    content: parsed.content,
                    revision: blockRevision({ title: parsedTitle, label: parsedLabel, content: parsed.content })
                };
                blocksMap.set(id, newBlock);
                blockIdToFileMap.set(id, filename);
                notifyClients({ type: 'update', block: newBlock });
            }, 100);
        });
    }

    // Vite middleware for development
    if (!isProduction) {
        const { createServer: createViteServer } = await import("vite");
        const testHmrPort = PORT <= 55535 ? PORT + 10000 : PORT - 10000;
        const vite = await createViteServer({
            // Middleware-mode Vite still binds its default HMR socket when two
            // dev servers run. Give each test server a port derived from HTTP.
            server: { middlewareMode: true, hmr: isTestMode ? { port: testHmrPort } : undefined },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        app.use(express.static(DIST_DIR));
        app.get('*', (req, res) => {
            res.sendFile(path.join(DIST_DIR, 'index.html'));
        });
    }

    app.listen(PORT, HOST, () => {
        console.log(`Server running on http://${HOST}:${PORT}`);
        console.log(`Workspace: ${WORKSPACE_DIR}`);
        if (isTestMode) console.log("Test mode enabled: all edits are stored in memory and discarded on exit.");
    });
}

startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
});
