import express from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { computeReferences, metadataText, parseFrontmatter, stringifyFrontmatter } from "./src/lib/block-metadata";
import { makeBlockFilename, normalizeBlockLabel, normalizeBlockTitle, validateBlockLabel, validateBlockMetadata, validateBlockTitle } from "./src/lib/label-policy";
import { applySafeRelabelPlan, buildSafeRelabelPlan, relabelPlanSignatureInput, SafeRelabelPlan } from "./src/lib/safe-relabel";
import { atomicWriteFile, backupFile } from "./src/lib/atomic-file";

const app = express();
const portArgumentIndex = process.argv.indexOf("--port");
const requestedPort = portArgumentIndex >= 0 ? Number(process.argv[portArgumentIndex + 1]) : 3000;
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535 ? requestedPort : 3000;
const HOST = process.env.HOST || "127.0.0.1";
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
const DIST_DIR = path.resolve(process.env.MATH_NOTE_DIST_DIR || path.join(process.cwd(), "dist"));

interface BlockData {
    id: string;
    title: string;
    label: string;
    content?: string;
    hasContent?: boolean;
    references?: string[];
}

let blocksMap = new Map<string, BlockData>();
let sseClients: express.Response[] = [];
let testSettings: Record<string, unknown> | null = null;
const testAssets = new Map<string, { buffer: Buffer; contentType: string }>();

app.get("/api/runtime", (_req, res) => {
    res.json({ testMode: isTestMode, desktop: process.env.MATH_NOTE_DESKTOP === "true" });
});

function notifyClients(message: any) {
    sseClients.forEach(client => {
        try {
            client.write(`data: ${JSON.stringify(message)}\n\n`);
        } catch (e) { }
    });
}

async function ensureDir(dir: string) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (e) {}
}

function workspaceBackupPath(targetPath: string) {
    const relativePath = path.relative(WORKSPACE_DIR, path.resolve(targetPath));
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error(`Cannot back up a file outside the workspace: ${targetPath}`);
    }
    return path.join(BACKUP_DIR, `${relativePath}.bak`);
}

function writeWorkspaceFile(targetPath: string, contents: string | Buffer) {
    return atomicWriteFile(targetPath, contents, { backupPath: workspaceBackupPath(targetPath) });
}

function backupWorkspaceFile(targetPath: string) {
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
        title: '0. Welcome to Math Notes 🚀',
        label: 'showcase:main',
        content: "Welcome to **Math Notes**!\n\nThis editor is designed to break down long, complex mathematical treatises into small, composable blocks. You can reference blocks inside other blocks.\n\nTry clicking on the chip below, or moving your cursor inside it and pressing `Enter`:\n[[showcase:embed-1]]\n\nWhen a block is toggled 'open', it expands inline so you can read and edit it directly within the parent block context. Like this:\n[[showcase:embed-2∨]]\n\nUse the + button to create a new root block in its own tab.",
    },
    {
        id: uuidv4(),
        title: '0.1 Inline Editing',
        label: 'showcase:embed-1',
        content: "You've successfully opened an embedded block! \n\nNotice how your focus smoothly shifted into this space. Try editing the text here, and press `Esc` or `Enter` or click the header to close it when you are done.\n\nYou can also use `ArrowUp` and `ArrowDown` to seamlessly step into open embedded blocks and out of them.",
    },
    {
        id: uuidv4(),
        title: '0.2 Relative Referencing & Infinite Recursion',
        label: 'showcase:embed-2',
        content: "Blocks can have paths like `folder:subfolder:block`. You can reference them relatively using a leading `/` in the embed syntax.\n\nFor example, this is `showcase:embed-2`, and there is a block called `showcase:embed-2/child`. Let's embed it!\n[[/child]]\n\nWhat happens if we try to embed `showcase:main` inside here?\n[[showcase:main]]\nCyclic references are automatically detected and stopped to prevent your browser from crashing!",
    },
    {
        id: uuidv4(),
        title: '0.2.1 Relative Child Block',
        label: 'showcase:embed-2/child',
        content: "I was referenced using `[[/child]]` rather than my full name `showcase:embed-2/child`!",
    },
    {
        id: uuidv4(),
        title: '1. Mathematical Capabilities 🧮',
        label: 'showcase:math',
        content: "Math Notes uses **KaTeX** to provide blazingly fast live previews of your math.\n\nFor block math, write your equations wrapped in `\\[` and `\\]`:\n\\[\n\\mathcal{F}\\{f(t)\\} = \\int_{-\\infty}^{\\infty} f(t) e^{-i\\omega t} dt\n\\]\n\nFor inline math, use single `$`. Try clicking into this equation to see the interactive math tooltip: $\\sum_{v \\in V} \\text{deg}(v) = 2|E|$. It lets you safely edit the raw LaTeX while previewing the outcome immediately above your cursor!",
    },
    {
        id: uuidv4(),
        title: '2. Aliases and Block Creation 🪄',
        label: 'showcase:aliases',
        content: "Sometimes you want to reference a block, but its label doesn't flow correctly in your sentence. Use the `||` double pipe character to set a custom alias!\n\nFor example: For more details, check out the [[showcase:math || math examples]]!\n\n**Creating on the fly:**\nWhat if you want to reference a block that doesn't exist yet?\nType its label inside `[[...]]` and choose the `Create new block` autocomplete option. The new target is created while your focus remains in the source note."
    },
    {
        id: uuidv4(),
        title: '3. All Features Showcase 🌟',
        label: 'showcase:features',
        content: "Here is a quick showcase of **all the formatting** you can use in Math Notes!\n\n**Markdown Styling**\n* You can use **bold text** for emphasis.\n* You can also use *italic text* if you prefer.\n* Or perhaps some _underline text_ to highlight things.\n\n**Mathematics**\nMath features make it easy to write equations, like $e^{i\\pi} + 1 = 0$ inline!\n\nFor more complex formulas, use block math:\n\\[\n\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}\n\\]\n\n**Embedded Blocks**\nYou can easily embed other blocks inline to build up complex thoughts.\nHere is the math page again: [[showcase:math || Math Features∨]]"
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
    
    let oldFilename = blockIdToFileMap.get(block.id);
    let baseDir = oldFilename ? path.dirname(oldFilename) : "";
    if (baseDir === ".") baseDir = "";

    let readableFilename = makeBlockFilename(block.title || "", block.label || "", block.id);
    let newFilename = baseDir ? path.join(baseDir, readableFilename) : readableFilename;

    const isConflict = Array.from(blockIdToFileMap.entries()).some(([i, f]) => f === newFilename && i !== block.id);
    if (isConflict) {
        readableFilename = makeBlockFilename(block.title || "", block.label || "", `${block.id}-duplicate`);
        newFilename = baseDir ? path.join(baseDir, readableFilename) : readableFilename;
    }

    const filePath = path.join(BLOCKS_DIR, newFilename);
    const fileContent = stringifyFrontmatter({
        id: block.id,
        title: block.title || "",
        label: block.label || ""
    }, block.content || "");
    
    if (baseDir) {
        await ensureDir(path.join(BLOCKS_DIR, baseDir));
    }
    if (oldFilename && oldFilename !== newFilename) {
        await backupWorkspaceFile(path.join(BLOCKS_DIR, oldFilename));
    }
    await writeWorkspaceFile(filePath, fileContent);

    if (oldFilename && oldFilename !== newFilename) {
        try {
            await fs.unlink(path.join(BLOCKS_DIR, oldFilename));
        } catch (e) {
            console.warn(`Could not delete old file ${oldFilename}:`, e);
        }
    }
    blockIdToFileMap.set(block.id, newFilename);
}

async function writeBlockToFile(block: BlockData) {
    const previous = blockWriteQueues.get(block.id) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => writeBlockToFileUnlocked(block));
    blockWriteQueues.set(block.id, current);
    try {
        await current;
    } finally {
        if (blockWriteQueues.get(block.id) === current) blockWriteQueues.delete(block.id);
    }
}

function blockMetadata(block: BlockData) {
    return {
        id: block.id,
        title: block.title,
        label: block.label,
        references: block.references || [],
        hasContent: block.hasContent ?? (block.content !== undefined && block.content.trim().length > 0)
    };
}

async function ensureBlockContent(id: string): Promise<BlockData | null> {
    const cached = blocksMap.get(id);
    if (!cached) return null;
    if (cached.content !== undefined) return cached;

    const filename = blockIdToFileMap.get(id);
    if (!filename) return cached;
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
    blocksMap.set(id, fullBlock);
    return fullBlock;
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
                    hasContent: parsed.content.trim().length > 0
                } satisfies BlockData
            };
        });
        for (const { file, block } of metadataEntries) {
            const id = block.id;
            const existingFilename = blockIdToFileMap.get(id);
            if (existingFilename) {
                throw new Error(`Duplicate block id "${id}" found in "${existingFilename}" and "${file}"`);
            }
            blocksMap.set(id, block);
            // Normalize path slashes for consistency across platforms (use forward slash in map)
            blockIdToFileMap.set(id, file.replace(/\\/g, '/'));
        }
    }
}

app.post("/api/assets", express.json({limit: '20mb'}), async (req, res) => {
    try {
        const { filePath, content } = req.body;
        const absolutePath = path.join(BLOCKS_DIR, filePath);
        if (!absolutePath.startsWith(path.join(BLOCKS_DIR, 'assets'))) {
            return res.status(400).json({error: "Invalid path"});
        }
        const base64Data = content.replace(/^data:[^;]+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        if (isTestMode) {
            const assetPath = filePath.replace(/^assets\//, '');
            const contentType = content.match(/^data:([^;]+);base64,/)?.[1] || 'application/octet-stream';
            testAssets.set(assetPath, { buffer, contentType });
            return res.json({ success: true, url: `assets/${assetPath}` });
        }
        await ensureDir(path.dirname(absolutePath));
        await writeWorkspaceFile(absolutePath, buffer);
        res.json({ success: true, url: `assets/${filePath.replace(/^assets\//, '')}` });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/assets-list", async (req, res) => {
    try {
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
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/assets/*", async (req, res) => {
    try {
        const assetPath = req.params[0];
        const testAsset = testAssets.get(assetPath);
        if (testAsset) {
            res.type(testAsset.contentType);
            return res.send(testAsset.buffer);
        }
        const absolutePath = path.join(BLOCKS_DIR, "assets", assetPath);
        res.sendFile(absolutePath);
    } catch (e) {
        res.status(500).json({ error: String(e) });
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
        const block = await ensureBlockContent(id);
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
        const content = await fs.readFile(settingsPath, "utf-8").catch(() => "{\"macros\":{},\"customCommands\":[],\"textCommands\":[]}");
        if (isTestMode) {
            testSettings ??= JSON.parse(content);
            return res.json(testSettings);
        }
        await ensureDir(settingDir);
        res.json(JSON.parse(content));
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post("/api/settings", async (req, res) => {
    try {
        if (isTestMode) {
            testSettings = structuredClone(req.body || {});
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
            blocksMap.set(block.id, block);
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
        const existing = await ensureBlockContent(id);
        if (!existing) {
            return res.status(404).json({ error: "Block not found" });
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

        const block: BlockData = {
            id,
            title: newTitle,
            label: newLabel,
            content: req.body.content !== undefined ? req.body.content : existing.content,
            hasContent: (req.body.content !== undefined ? req.body.content : existing.content || "").trim().length > 0
        };
        block.references = computeReferences(block.content || "");
        await writeBlockToFile(block);
        blocksMap.set(id, block);
        res.json({ block, updatedBlocks: [block] });
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
        const filename = blockIdToFileMap.get(id);
        if (isTestMode) {
            blockIdToFileMap.delete(id);
        } else if (filename) {
            const filePath = path.join(BLOCKS_DIR, filename);
            await backupWorkspaceFile(filePath);
            await fs.unlink(filePath).catch(() => {});
            blockIdToFileMap.delete(id);
        } else {
            const fallbackPath = path.join(BLOCKS_DIR, `${id}.md`);
            await fs.unlink(fallbackPath).catch(() => {});
        }
        blocksMap.delete(id);
        res.json({ success: true });
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
        fsSync.watch(BLOCKS_DIR, (eventType, filename) => {
            if (!filename || !filename.endsWith('.md')) return;
            
            setTimeout(async () => {
                const filePath = path.join(BLOCKS_DIR, filename);
                let content;
                try {
                    content = await fs.readFile(filePath, "utf-8");
                } catch (e) {
                    const id = Array.from(blockIdToFileMap.entries()).find(([k, v]) => v === filename)?.[0];
                    if (id && blocksMap.has(id)) {
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
                    console.error(`Ignoring duplicate block id "${id}" in "${filename}"; already loaded from "${mappedFilename}"`);
                    return;
                }
                
                const existing = blocksMap.get(id);
                const parsedTitle = normalizeBlockTitle(metadataText(parsed.data.title));
                const parsedLabel = normalizeBlockLabel(metadataText(parsed.data.label));
                if (existing && existing.content === parsed.content && existing.title === parsedTitle && existing.label === parsedLabel) {
                    return; // No change or our own update
                }

                const newBlock: BlockData = {
                    id,
                    title: parsedTitle,
                    label: parsedLabel,
                    references: computeReferences(parsed.content),
                    content: parsed.content
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
        const vite = await createViteServer({
            server: { middlewareMode: true, hmr: isTestMode ? false : undefined },
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
