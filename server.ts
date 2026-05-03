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
        content: "Sometimes you want to reference a block, but its label doesn't flow correctly in your sentence. Use the `|` pipe character to set a custom alias!\n\nFor example: For more details, check out the [[showcase:math | math examples]]!\n\n**Creating on the fly:**\nWhat if you want to reference a block that doesn't exist yet?\nJust type it out, e.g., `[[showcase:new-idea | My Brilliant Idea]]`, close the brackets, and then put your cursor on the chip and hit `Enter` (or click on the alias). A new block will seamlessly be created for you! Try it here on this non-existent block:\n[[test:create-me]]"
    }
];

async function writeBlockToFile(block: any) {
    const filePath = path.join(BLOCKS_DIR, `${block.id}.md`);
    const fileContent = matter.stringify(block.content || "", {
        title: block.title,
        label: block.label
    });
    await fs.writeFile(filePath, fileContent, "utf-8");
}

async function initBlocks() {
    await ensureDir(BLOCKS_DIR);
    const files = await fs.readdir(BLOCKS_DIR);
    if (files.filter(f => f.endsWith(".md")).length === 0) {
        for (const block of INITIAL_BLOCKS) {
            await writeBlockToFile(block);
        }
    }
}

app.get("/api/blocks", async (req, res) => {
    try {
        const files = await fs.readdir(BLOCKS_DIR);
        const mdFiles = files.filter(f => f.endsWith(".md"));
        const blocks = [];
        
        for (const file of mdFiles) {
            const filePath = path.join(BLOCKS_DIR, file);
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = matter(content);
            blocks.push({
                id: file.replace(".md", ""),
                title: parsed.data.title || "",
                label: parsed.data.label || "",
                content: parsed.content,
                // store metadata about index/order? To keep it simple, we just parse it.
                // Normally we'd need an index or order. Let's just return them.
                 _fileMeta: { createdAt: (await fs.stat(filePath)).birthtimeMs }
            });
        }
        
        // Sort by some logic to keep them somewhat consistent (e.g., creation time or alphabetical)
        blocks.sort((a, b) => a.title.localeCompare(b.title));
        
        res.json(blocks);
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
        res.json(block);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.put("/api/blocks/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const filePath = path.join(BLOCKS_DIR, `${id}.md`);
        
        // Read existing to merge
        let existing = { title: "", label: "", content: "" };
        try {
            const currentContent = await fs.readFile(filePath, "utf-8");
            const parsed = matter(currentContent);
            existing = {
                title: parsed.data.title || "",
                label: parsed.data.label || "",
                content: parsed.content
            };
        } catch(e) {} // If doesn't exist, we just overwrite
        
        const block = {
            id,
            title: req.body.title !== undefined ? req.body.title : existing.title,
            label: req.body.label !== undefined ? req.body.label : existing.label,
            content: req.body.content !== undefined ? req.body.content : existing.content
        };
        
        await writeBlockToFile(block);
        res.json(block);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/api/blocks/:id/raw", async (req, res) => {
    try {
        const id = req.params.id;
        const filePath = path.join(BLOCKS_DIR, `${id}.md`);
        const content = await fs.readFile(filePath, "utf-8");
        res.setHeader('Content-Type', 'text/plain');
        res.send(content);
    } catch (e) {
        res.status(404).json({ error: "File not found" });
    }
});

app.delete("/api/blocks/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const filePath = path.join(BLOCKS_DIR, `${id}.md`);
        await fs.unlink(filePath);
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
