# Math Note Editor

Math Note Editor is a local-first Markdown editor for connected mathematical notes.

Its main idea is simple: a block can contain another block. Open an embedded block to read and edit its content directly inside the current note. The edit changes the referenced block itself, so every other embedding stays consistent.

```text
Definition
└─ Theorem
   └─ Proof
```

You can work through this structure without repeatedly leaving the note you are reading.

## Features

- Read and edit embedded blocks in place.
- Render inline and display mathematics with KaTeX.
- Organize notes with hierarchical labels such as `analysis/sequences/convergence`.
- Follow references, backlinks, parents, and children in Blocks View.
- Search large workspaces without losing hierarchy context.
- Detect duplicate labels, missing references, empty notes, and isolated notes.
- Prevent infinite rendering when references form cycles.
- Store notes as portable Markdown files in a local workspace.
- Run in a browser, as a PWA, or as a packaged desktop application.

## Embedding blocks

Reference another block by label:

```text
[[analysis/sequences/convergence]]
```

Useful forms:

```text
[[label || Display name]]   Alias
[[@label]]                  Standalone section
[[/child]]                  Relative child label
[[label∨]]                  Open embedded content
```

An open embed is an editor, not a copied preview. Changes are saved to the referenced block.

## Workspace

```text
My Math Notes/
├── *.md
├── assets/
└── setting/
    └── settings.json
```

Each block is a Markdown file with a stable ID, title, and label. Images are stored in `assets/`. Workspace settings, open tabs, and recovery data remain separate from the application.

The development server uses `blocks/` by default. Set `MATH_NOTE_WORKSPACE` to use another directory. The desktop application asks for a workspace when needed.

## Development

Requires Node.js and npm.

```bash
npm install
npm run dev
```

Checks and builds:

```bash
npm run lint
npm run test:e2e
npm run build
npm run build:analyze
```

`build:analyze` generates `bundle-report.html`.

## Desktop

```bash
npm run desktop:dev
npm run desktop:pack
npm run desktop:dist
```

The desktop package includes the local server. Removing or upgrading the application does not remove its workspace.

## Browser and PWA

```bash
npm run build
npm start -- --port 3100
```

Open `http://127.0.0.1:3100`. The GitHub Pages version has no server; use **Open Workspace** to grant access to a local directory, or use the read-only folder viewer where direct file access is unavailable.

## Data safety

The editor writes directly to the selected workspace. Keep independent backups of important notes. Previous versions can be restored from **Settings → General Setting → Backup Recovery**.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design.
