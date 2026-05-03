# Math Notes Editor

> A block-based WYSIWYG math note editor powered by live KaTeX rendering and CodeMirror 6.

Math Notes Editor is a modern, modular text editor designed for structuring knowledge logically and mathematically. It bridges the gap between text files and networked thought by supporting embedded modular blocks, rich mathematics, and an extensible WYSIWYG editing experience.

## ✨ Key Features

### 🧱 Block-Based Architecture
- **Content as Blocks:** Documents are built from modular blocks of text that can be referenced or pieced together.
- **Local Markdown Sync:** Automatically synchronizes and saves your content as raw Markdown files using a local Express backend.
- **Raw File Inspection:** Access and review your core data easily through backend endpoints (e.g., `/api/blocks/:id/raw`).

### 🔗 Powerful Block Embeddings
- **Inline Linking & Standouts:** Use the intuitive `[[label]]` syntax to link to other blocks inline, or `[[@label]]` for standalone highlighted blocks.
- **Interactive Expansion:** Toggle embeds open and closed natively (e.g., `[[label∨]]`) within your current view—letting you read or edit block contents without context-switching.
- **Aliasing:** Customize how links display in sentences using the pipe syntax `[[label | Custom Alias]]`.
- **Creation on Demand:** Pressing `Enter` on an uncreated block link smoothly initializes the file and directs your focus to edit it.
- **Cycle Detection:** Built-in infinite-recursion prevention stops circular nesting from breaking your user interface.

### 🧮 Live Mathematics (KaTeX)
- **Live Preview:** Immediate KaTeX rendering ensures math equations compile visually as you type.
- **Math Tooltip Editors:** Focus into an inline mathematical phrase, and the editor seamlessly floats a live-rendered tooltip directly above your cursor, preserving text layout flow while updating.

### 📝 Elevated Editing Experience (CodeMirror 6 + React)
- **Fluid UI Hooks:** Built with a custom CodeMirror plugin architecture rendering React components (`WidgetType` elements) directly inside the markdown document flow.
- **Accessible & Polished Design:** Focus-optimized, distinct text selection styling, and carefully managed Z-indices keep tooltips and widgets clipping-free.
- **Optimized Lifecycles:** Smooth UI transitions and interactions without unwanted DOM layout flashes, preventing cursor deselection when engaging with widget headers.

## 🛠 Tech Stack

- **Frontend:** [React 19](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS 4](https://tailwindcss.com/)
- **Editor:** [CodeMirror 6](https://codemirror.net/)
- **State Management:** [Zustand](https://zustand-demo.pmnd.rs/)
- **Math Rendering:** [KaTeX](https://katex.org/)
- **Backend / Delivery:** [Express](https://expressjs.com/), [Node.js](https://nodejs.org/)

## 🚀 Getting Started

1. **Install Dependencies**
   ```bash
   npm install
   ```
2. **Start the Development Server**
   ```bash
   npm run dev
   ```
3. **Build for Production** 
   ```bash
   npm run build
   npm start
   ```

## 🗺 What's Next
Refer to [`ARCHITECTURE.md`](./ARCHITECTURE.md) for architectural notes, design decisions, and future roadmap items, such as improving global keyboard navigation and selection boundaries.
