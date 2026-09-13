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

## Workspace format

The web server and desktop application use the same portable workspace format:

```text
My Math Notes/
├── *.md                  Note blocks (subfolders are supported)
├── assets/               Pasted images and other note assets
└── setting/
    └── settings.json     Macros, autocomplete entries, colors, and editor settings
```

The web server uses `blocks/` by default. Set `MATH_NOTE_WORKSPACE` to use another folder. The desktop application asks for a workspace on first launch and remembers it; **File → Open Workspace…** switches folders later.

## Install and test the PWA

```bash
npm run build
npm start -- --port 3100
```

Open `http://127.0.0.1:3100`, then use Chrome or Edge's **Install Math Note Editor** action. Keep the local server running while testing a localhost installation. A hosted HTTPS deployment runs its server for users and does not require them to use a terminal.

The cached application shell can open offline, but server-backed editing still requires the server. When it is unavailable, connect a local workspace from the application's **Open Workspace** action.

## Run and package the desktop application

Run the desktop build locally:

```bash
npm run desktop:dev
```

Create an unpacked application for smoke testing:

```bash
npm run desktop:pack
```

Create installable artifacts for the current operating system:

```bash
npm run desktop:dist
```

The packaged application includes the web interface and local backend. It starts the backend automatically, so users do not need Node.js or a manually started server.

To test without touching your real notes, create an empty folder such as `Math Notes Test` and select it as the workspace. Notes, assets, and settings stay inside the selected folder. Use **File → Open Workspace…** to return to your normal workspace later.

Open note tabs and the active tab are saved in `setting/settings.json` as part of that workspace. Switching workspaces therefore restores each workspace's own tab session, including after restarting the desktop app.

Previous saved file versions can be reviewed under **Settings → General Setting → Backup Recovery**. Restoring swaps the current and backup versions, so the same action can reverse an accidental restore.

Desktop updates are currently manual: build or download the newer installer, quit Math Note Editor, and install it over the existing application. Workspaces are stored separately from the application, so replacing the application does not replace your notes or workspace settings. Increase the `version` in `package.json` before creating a distributable release so the installer and operating system can distinguish versions.

The GitHub Pages version is built separately from the same interface. It has no Node backend; use **Open Workspace** and grant access to a local workspace folder. Pushing desktop code does not alter note files and does not make the desktop backend available on GitHub Pages.

Desktop note-tab shortcuts:

- `Cmd/Ctrl+W`: close the current note tab without deleting its note
- `Cmd/Ctrl+Shift+T`: reopen the most recently closed note tab
- `Ctrl+Tab`: move to the next note tab
- `Ctrl+Shift+Tab`: move to the previous note tab
- `Cmd/Ctrl+Shift+W`: close the desktop window

Before distributing a release, test installation, workspace switching, restart persistence, application upgrades, and uninstall behavior on a clean machine. Signing and notarization credentials are intentionally not stored in this repository.

Never use your only copy of a real workspace for release testing. Copy the complete workspace folder, verify that the copy opens correctly, and run install, upgrade, restart, recovery, and uninstall tests against the copy. Keep the original app closed during destructive failure tests such as forced termination, removed-drive simulation, permissions changes, or low-disk-space testing.

## 🗺 What's Next
Refer to [`ARCHITECTURE.md`](./ARCHITECTURE.md) for architectural notes, design decisions, and future roadmap items, such as improving global keyboard navigation and selection boundaries.
