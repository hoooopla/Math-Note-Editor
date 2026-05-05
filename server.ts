import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = 3000;
app.use(express.json());

const BLOCKS_DIR = path.join(process.cwd(), "blocks");

interface BlockData {
    id: string;
    title: string;
    label: string;
    content: string;
}

let blocksMap = new Map<string, BlockData>();

async function ensureDir(dir: string) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (e) {}
}

const INITIAL_BLOCKS = [
    {
        id: uuidv4(),
        title: '0. Welcome to Math Notes 🚀',
        label: 'showcase:main',
        content: "Welcome to **Math Notes**!\n\nThis editor is designed to break down long, complex mathematical treatises into small, composable blocks. You can reference blocks inside other blocks.\n\nTry clicking on the chip below, or moving your cursor inside it and pressing `Enter`:\n[[showcase:embed-1]]\n\nWhen a block is toggled 'open', it expands inline so you can read and edit it directly within the parent block context. Like this:\n[[showcase:embed-2∨]]\n\nYou can also click the empty space below this block to create a new one!",
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
        content: "Math Notes uses **KaTeX** to provide blazingly fast live previews of your math.\n\nFor block math, write your equations wrapped in `$$`:\n$$\n\\mathcal{F}\\{f(t)\\} = \\int_{-\\infty}^{\\infty} f(t) e^{-i\\omega t} dt\n$$\n\nFor inline math, use single `$`. Try clicking into this equation to see the interactive math tooltip: $\\sum_{v \\in V} \\text{deg}(v) = 2|E|$. It lets you safely edit the raw LaTeX while previewing the outcome immediately above your cursor!",
    },
    {
        id: uuidv4(),
        title: '2. Aliases and Block Creation 🪄',
        label: 'showcase:aliases',
        content: "Sometimes you want to reference a block, but its label doesn't flow correctly in your sentence. Use the `||` double pipe character to set a custom alias!\n\nFor example: For more details, check out the [[showcase:math || math examples]]!\n\n**Creating on the fly:**\nWhat if you want to reference a block that doesn't exist yet?\nJust type it out, e.g., `[[showcase:new-idea || My Brilliant Idea]]`, close the brackets, and then put your cursor on the chip and hit `Enter` (or click on the alias). A new block will seamlessly be created for you! Try it here on this non-existent block:\n[[test:create-me]]"
    },
    {
        id: uuidv4(),
        title: '3. All Features Showcase 🌟',
        label: 'showcase:features',
        content: "Here is a quick showcase of **all the formatting** you can use in Math Notes!\n\n**Markdown Styling**\n* You can use **bold text** for emphasis.\n* You can also use *italic text* if you prefer.\n* Or perhaps some _underline text_ to highlight things.\n\n**Mathematics**\nMath features make it easy to write equations, like $e^{i\\pi} + 1 = 0$ inline!\n\nFor more complex formulas, use block math:\n$$\n\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}\n$$\n\n**Embedded Blocks**\nYou can easily embed other blocks inline to build up complex thoughts.\nHere is the math page again: [[showcase:math || Math Features∨]]"
    }
];

const blockIdToFileMap = new Map<string, string>();

async function writeBlockToFile(block: any) {
    const safeTitle = (block.title || "Untitled").replace(/[/\\?%*:|"<>]/g, '-').trim() || "Untitled";
    let oldFilename = blockIdToFileMap.get(block.id);
    let newFilename = `${safeTitle}.md`;

    const isConflict = Array.from(blockIdToFileMap.entries()).some(([i, f]) => f === newFilename && i !== block.id);
    if (isConflict) {
        newFilename = `${safeTitle} - ${block.id.slice(0, 8)}.md`;
    }

    const filePath = path.join(BLOCKS_DIR, newFilename);
    const fileContent = matter.stringify(block.content || "", {
        id: block.id,
        title: block.title,
        label: block.label
    });
    await fs.writeFile(filePath, fileContent, "utf-8");

    if (oldFilename && oldFilename !== newFilename) {
        try {
            await fs.unlink(path.join(BLOCKS_DIR, oldFilename));
        } catch (e) {
            console.warn(`Could not delete old file ${oldFilename}:`, e);
        }
    }
    blockIdToFileMap.set(block.id, newFilename);
}

async function initBlocks() {
    await ensureDir(BLOCKS_DIR);
    const files = await fs.readdir(BLOCKS_DIR);
    if (files.filter(f => f.endsWith(".md")).length === 0) {
        for (const block of INITIAL_BLOCKS) {
            await writeBlockToFile(block);
            blocksMap.set(block.id, block);
        }
    } else {
        const mdFiles = files.filter(f => f.endsWith(".md"));
        for (const file of mdFiles) {
            const filePath = path.join(BLOCKS_DIR, file);
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = matter(content);
            const id = parsed.data.id || file.replace(".md", "");
            blocksMap.set(id, {
                id,
                title: parsed.data.title || "",
                label: parsed.data.label || "",
                content: parsed.content
            });
            blockIdToFileMap.set(id, file);
        }
    }
}

app.get("/api/blocks", async (req, res) => {
    try {
        const blocks = Array.from(blocksMap.values()).map(b => ({
            id: b.id,
            title: b.title,
            label: b.label
            // we do NOT send content to make it fast for 10000+ blocks!
            // wait, if we don't send content, the frontend must be updated to load it on demand.
            // to avoid instantly breaking the app, let's include it for now, 
            // but we add a query parameter ?metaOnly=true for search views
        }));
        
        // Sort by title
        blocks.sort((a, b) => a.title.localeCompare(b.title));
        
        if (req.query.metaOnly === 'true') {
            res.json(blocks);
        } else {
            // send all content (might be slow but doesn't break current frontend yet)
            res.json(Array.from(blocksMap.values()).sort((a, b) => a.title.localeCompare(b.title)));
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/blocks/:id", async (req, res) => {
    try {
        const id = req.params.id;
        if (blocksMap.has(id)) {
            res.json(blocksMap.get(id));
        } else {
            res.status(404).json({ error: "File not found" });
        }
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post("/api/blocks", async (req, res) => {
    try {
        const id = uuidv4();
        const block = {
            id,
            title: req.body.title || "New Block",
            label: req.body.label || "block",
            content: req.body.content || ""
        };
        await writeBlockToFile(block);
        blocksMap.set(block.id, block);
        res.json(block);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.put("/api/blocks/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const existing = blocksMap.get(id) || { title: "", label: "", content: "", id };
        
        const newLabel = req.body.label !== undefined ? req.body.label : existing.label;
        const oldLabel = existing.label;

        const block = {
            id,
            title: req.body.title !== undefined ? req.body.title : existing.title,
            label: newLabel,
            content: req.body.content !== undefined ? req.body.content : existing.content
        };

        let updatedBlocks = [block];
        blocksMap.set(id, block);

        if (oldLabel && newLabel && oldLabel !== newLabel) {
            const renames = [{ old: oldLabel, new: newLabel, id }];
            
            // Find child blocks to rename
            for (const [bId, b] of blocksMap.entries()) {
                if (bId !== id && b.label.startsWith(oldLabel + "/")) {
                    const childNewLabel = newLabel + b.label.substring(oldLabel.length);
                    renames.push({ old: b.label, new: childNewLabel, id: bId });
                }
            }

            // Apply renames
            updatedBlocks = [];
            for (const [bId, b] of blocksMap.entries()) {
                let changed = false;
                let newB = { ...b };
                
                const renameMatch = renames.find(r => r.id === bId);
                if (renameMatch && bId !== id) {
                    newB.label = renameMatch.new;
                    changed = true;
                }

                if (newB.content) {
                    // Check against original label before rename, just in case
                    const baseLabel = b.label; 
                    
                    for (const r of renames) {
                        const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        
                        // Absolute replacement
                        const regex = new RegExp(`\\[\\[(@)?(${escapeRegExp(r.old)})((\\|\\|[^\\]∨]+)?)?(∨)?\\]\\]`, 'g');
                        let nextContent = newB.content.replace(regex, (match: string, at: string, old: string, title: string, something: string, open: string) => {
                            return `[[${at || ''}${r.new}${title || ''}${open || ''}]]`;
                        });

                        // Relative replacement
                        if (r.old.startsWith(baseLabel + "/")) {
                            const oldRelative = r.old.substring(baseLabel.length);
                            const newRelative = r.new.startsWith(newB.label + "/") ? r.new.substring(newB.label.length) : r.new;
                            
                            const relRegex = new RegExp(`\\[\\[(@)?(${escapeRegExp(oldRelative)})((\\|\\|[^\\]∨]+)?)?(∨)?\\]\\]`, 'g');
                            nextContent = nextContent.replace(relRegex, (match: string, at: string, old: string, title: string, something: string, open: string) => {
                                return `[[${at || ''}${newRelative}${title || ''}${open || ''}]]`;
                            });
                        }

                        if (nextContent !== newB.content) {
                            newB.content = nextContent;
                            changed = true;
                        }
                    }
                }

                if (changed || bId === id) {
                    blocksMap.set(bId, newB);
                    updatedBlocks.push(newB);
                }
            }
        }

        // Save all modified blocks to disk
        for (const b of updatedBlocks) {
            await writeBlockToFile(b);
        }

        // Re-get the root block in case it was modified during the rename iteration
        const finalBlock = blocksMap.get(id) || block;
        res.json({ block: finalBlock, updatedBlocks });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/blocks/:id/raw", async (req, res) => {
    try {
        const id = req.params.id;
        const block = blocksMap.get(id);
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
        const id = req.params.id;
        const filename = blockIdToFileMap.get(id);
        if (filename) {
            const filePath = path.join(BLOCKS_DIR, filename);
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

async function startServer() {
    await initBlocks();

    // Vite middleware for development
    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

startServer();
