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
        title: '0.0 Navigation Example Main',
        label: 'nav:main',
        content: 'This is the showcase for navigation in the editor.\nYou can use the \'ArrowUp\' and \'ArrowDown\' keys to seamlessly enter and exit embedded blocks.\nYou can also use \'Enter\' to open and close embedded blocks, which automatically focuses the proper bounds.\n\nHere is a simple closed block to try \'Enter\' on:\n[[nav:child1]]\n\nAnd here is an open block you can navigate into by just pressing \'ArrowDown\' from the line above it!\n[[nav:child2∨]]\n\nThis completes our showcase. Try navigating all the way from the top to the bottom using just the arrow keys!',
    },
    {
        id: uuidv4(),
        title: '0.0.1 Navigation Child 1',
        label: 'nav:child1',
        content: 'You\'ve opened the first child using \'Enter\'!\nYou can press \'Esc\' to blur out, \'Enter\' again to close it, or just use your arrow keys to go up/down.',
    },
    {
        id: uuidv4(),
        title: '0.0.2 Navigation Child 2',
        label: 'nav:child2',
        content: 'You are now inside the second child block!\nNotice how smooth the transition is?\nIf you press \'ArrowUp\' from the first line, you\'ll go jump back to the parent block above the embed.\nIf you press \'ArrowDown\' from the last line (here), you\'ll jump to the parent block below the embed!',
    },
    {
        id: uuidv4(),
        title: '0. Test Cases for Embedded Blocks',
        label: 'test:embeds',
        content: 'Here are tests covering all embedding features:\n\n1. Basic embedding (inline, closed):\n[[sec:intro]]\n\n2. Standout embedding (standout, closed):\n[[@sec:intro]]\n\n3. Embedded open (inline, open):\n[[sec:intro∨]]\n\n4. Standout embedded open (standout, open):\n[[@sec:intro∨]]\n\n5. Aliasing (inline with alias, closed):\n[[sec:intro | Intro to Fourier]]\n\n6. Recursive and relative path (parent block with child target):\n[[@/child]]',
    },
    {
        id: uuidv4(),
        title: '0.1 Child block for relative path test',
        label: 'test:embeds/child',
        content: 'This block is a child. It can be referenced relatively from its parent `test:embeds` via `[[/child]]`.\n\nLet\'s test the relative path:\n[[/grandchild]]',
    },
    {
        id: uuidv4(),
        title: '0.1.1 Grandchild block for relative path test',
        label: 'test:embeds/child/grandchild',
        content: 'This is the grandchild.',
    },
    {
        id: uuidv4(),
        title: '1. Introduction to the Fourier Transform',
        label: 'sec:intro',
        content: 'The **Continuous Fourier Transform** (CFT) is a highly mathematical operation that transforms a function of time, $f(t)$, into a function of frequency, $\\hat{f}(\\omega)$. Over the domain $\\R$, the transform provides a frequency-domain representation of the original signal.\n\nThe forward Fourier Transform is defined as:\n\n$$\n\\hat{f}(\\omega) = \\mathcal{F}\\{f(t)\\} = \\int_{-\\infty}^{\\infty} f(t) e^{-i\\omega t} dt\n$$\n\nConversely, we can recover the original time-domain signal $f(t)$ from its frequency spectrum using the **Inverse Fourier Transform**:\n\n$$\nf(t) = \\mathcal{F}^{-1}\\{\\hat{f}(\\omega)\\} = \\frac{1}{2\\pi} \\int_{-\\infty}^{\\infty} \\hat{f}(\\omega) e^{i\\omega t} d\\omega\n$$',
    },
    {
        id: uuidv4(),
        title: '2. Key Properties',
        label: 'sec:properties',
        content: 'The Fourier transform exhibits several fundamental properties that make it a powerful tool in signal processing and differential equations:\n\n**Linearity:**\nFor any constants $a, b \\in \\mathbb{C}$ and functions $f(t), g(t)$:\n$$\n\\mathcal{F}\\{a f(t) + b g(t)\\} = a\\hat{f}(\\omega) + b\\hat{g}(\\omega)\n$$\n\n**Time Shifting:**\nA delay in the time domain corresponds to a linear phase shift in the frequency domain.\n$$\n\\mathcal{F}\\{f(t - t_0)\\} = e^{-i\\omega t_0} \\hat{f}(\\omega)\n$$\n\n**Frequency Shifting (Modulation):**\n$$\n\\mathcal{F}\\{e^{i\\omega_0 t} f(t)\\} = \\hat{f}(\\omega - \\omega_0)\n$$',
    },
    {
        id: uuidv4(),
        title: '3. The Convolution Theorem',
        label: 'sec:convolution',
        content: 'One of the most important theorems related to the Fourier Transform is the **Convolution Theorem**. It states that convolution in the time domain is equivalent to point-wise multiplication in the frequency domain.\n\nLet the convolution of two functions $f$ and $g$ be defined as:\n\n$$\n(f * g)(t) = \\int_{-\\infty}^{\\infty} f(\\tau) g(t - \\tau) d\\tau\n$$\n\nApplying the Fourier Transform to both sides, we get:\n\n$$\n\\mathcal{F}\\{(f * g)(t)\\} = \\hat{f}(\\omega) \\cdot \\hat{g}(\\omega)\n$$\n\nThis fundamentally simplifies solving linear time-invariant (LTI) systems, converting complex integral equations into straightforward algebraic multiplications.',
    },
    {
        id: uuidv4(),
        title: '4. Common Example: Rectangular Pulse',
        label: 'ex:rect',
        content: 'Consider the rectangular pulse function (also known as the window function), defined as:\n\n$$\n\\text{rect}(t) = \n\\begin{cases} \n1 & \\text{if } |t| < \\frac{1}{2} \\\\ \n0 & \\text{if } |t| > \\frac{1}{2} \n\\end{cases}\n$$\n\nThe Fourier transform of the rectangular pulse evaluates to the normalized **sinc** function:\n\n$$\n\\mathcal{F}\\{\\text{rect}(t)\\} = \\int_{-1/2}^{1/2} 1 \\cdot e^{-i\\omega t} dt = \\frac{e^{-i\\omega/2} - e^{i\\omega/2}}{-i\\omega} = \\frac{\\sin(\\omega/2)}{\\omega/2} = \\text{sinc}\\left(\\frac{\\omega}{2\\pi}\\right)\n$$\n\nThis duality illustrates that a perfectly bounded signal in time creates an infinitely extending frequency spectrum.',
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
