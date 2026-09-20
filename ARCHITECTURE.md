# Architecture

Math Note Editor is a local-first, block-based Markdown editor. Its defining behavior is recursive editable embedding: a referenced block can be opened and edited inside the note that references it.

## System map

```text
React application
├─ Workspace and tab shell
├─ CodeMirror block editors
│  └─ Recursive embedded editors
├─ Search, backlinks, and workspace diagnostics
├─ Blocks View
└─ Graph View
        │
        ▼
Zustand workspace state
├─ Normalized block index
├─ Active tab and nested-focus state
├─ Ordered save queues
└─ Backend adapter
        │
        ├─ Express workspace server
        ├─ Browser File System Access API
        └─ Read-only folder viewer
                │
                ▼
Markdown files, assets, settings, sessions, and backups
```

Electron packages the web application with the Express server. Notes remain in a user-selected workspace outside the application bundle.

## Storage modes

The frontend uses one backend interface with three implementations:

- **Server/desktop:** Express reads and writes the workspace.
- **Local browser:** the File System Access API writes to an authorized directory.
- **Viewer:** selected files are loaded into memory and remain read-only.

The server and local-browser implementations share the same metadata parsing, label validation, reference parsing, relabel planning, and backup rules. This prevents the browser and desktop versions from developing different workspace semantics.

## Workspace layout

```text
workspace/
├─ *.md
├─ nested/directories/*.md
├─ assets/
├─ setting/
│  └─ settings.json
└─ .math-note-backups/
```

Markdown files are the source of truth. Settings, session state, assets, and backups are workspace data rather than application data.

## Block identity and metadata

```ts
interface BlockData {
  id: string;
  title: string;
  label: string;
  content?: string;
  hasContent?: boolean;
  references?: string[];
}
```

- `id` is stable application identity.
- `label` is the human-authored address used by references and hierarchy.
- `title` is the display name and may contain mathematical notation.
- `content` is Markdown and LaTeX.
- `hasContent` allows metadata-only loading.
- `references` are derived from content and are not authoritative frontmatter.

Each Markdown file contains `id`, `title`, and `label` in YAML frontmatter. The body contains the note. Filenames are safe, bounded storage names; links do not depend on filenames.

Metadata is normalized to Unicode NFC. Titles and labels are validated at both UI and storage boundaries. Direct changes that would bypass a safe subtree relabel are rejected.

## Label hierarchy and namespaces

Labels use slash-separated paths:

```text
analysis
analysis/sequences
analysis/sequences/convergence
```

A block’s parent is its nearest existing ancestor. Missing intermediate segments can appear as virtual namespace nodes, but they are not blocks and cannot contain note content.

Block identity and label identity are deliberately separate. A label may change while the block ID remains stable. Duplicate labels are ambiguous and therefore excluded from normal label lookup until repaired.

## References and editable embedding

The reference parser recognizes:

```text
[[label]]
[[label || Alias]]
[[@label]]
[[/relative-child]]
[[label∨]]
```

- `@` displays the reference as a standalone section.
- `/` resolves the label relative to the containing block.
- `∨` records that the embedded block is open.
- `||` provides display text without changing the target.

CodeMirror replaces reference syntax with an interactive React widget. A closed widget is a compact reference. An open widget mounts the referenced block’s editor inside the current editor.

```text
Parent block editor
└─ embedded-block widget
   └─ referenced block editor
      └─ another embedded-block widget
```

The nested editor updates the referenced block itself; it does not copy content into the parent. A visited-label chain stops cyclic references from rendering recursively forever. Cycles remain valid graph relationships.

Missing references can create a target on demand. Repeated references are counted, backlinks are derived by indexing resolved outgoing references, and line excerpts are calculated when the backlinks popover is opened.

## Safe rename and subtree relabel

A label change may affect descendants and any note that references the renamed path. It is therefore a reviewed workspace transaction rather than a normal block update.

```text
Edit label
   │
   ▼
Flush pending block saves
   │
   ▼
Build preview plan
├─ root label change
├─ descendant label changes
├─ rewritten incoming references
├─ unresolved-reference warnings
└─ collision and path validation
   │
   ▼
User reviews plan
   │
   ▼
Commit against workspace revision
   │
   ├─ revision changed → reject and preview again
   └─ revision matches → backup, write, notify clients
```

The planner handles rename, move, parent insertion/removal, virtual ancestors, relative references, aliases, repeated links, escaped syntax, self-references, and cycles. It rejects destination collisions, invalid labels, moving a subtree into itself, and descendant labels that would exceed limits.

Preview plans include a deterministic signature and workspace revision. The server recomputes the plan during commit instead of trusting client-supplied mutations. If any write fails, snapshots are used to restore the pre-commit files.

## Duplicate-label recovery

Duplicate labels cannot be resolved safely by selecting an arbitrary winner. The workspace validator groups conflicts and removes the label from the normal lookup index.

Affected blocks are read-only. Workspace Issues asks the user to give each conflicting block a unique label. Existing references continue to resolve only after the ambiguity is removed; the application does not silently redirect them.

## Client state and loading

Zustand stores normalized state:

- `blockOrder` preserves workspace order.
- `blocksById` provides stable lookup.
- `blockIdByLabel` contains only unambiguous labels.
- `openTabs` and `activeTab` define the workspace session.
- Per-tab focus state preserves the active nested editor, cursor position, horizontal position, and navigation direction.
- `workspaceIssues` contains duplicate-label groups.

The initial block request is metadata-only. Note bodies load when opened or when an embedded editor approaches the viewport. This avoids loading every document in a large workspace.

The server publishes updates through Server-Sent Events. Other open clients can reload, update, or remove affected blocks without polling.

## Editing system

CodeMirror 6 supplies the editable surface. Custom extensions provide:

- Markdown parsing and continuation.
- Inline and display KaTeX rendering.
- LaTeX and text autocomplete.
- Embedded-block widgets and nested-editor selection.
- Image previews and URL links.
- Automatic replacements and bracket closure.
- Boundary-aware keyboard navigation between parent and child editors.

Raw math remains editable. When focus leaves a math range, it becomes a rendered KaTeX widget. While editing display math, a live preview remains visible without replacing the source.

Nested focus is represented as a label path. Navigation can enter an embed, return to its parent, cross visual editor boundaries, switch tabs, and later restore the previous nested position.

## Save ordering and failure recovery

Edits update client state immediately. Persistence uses a separate serialized promise chain for each block:

```text
edit version 1 ─┐
edit version 2 ─┼─► ordered save queue ─► latest state remains authoritative
edit version 3 ─┘
```

This prevents a slow older request from overwriting a newer edit. Dirty versions are tracked until the matching save finishes. Failures remain visible and the newest content is retried after a later edit.

Pending saves are flushed before relabeling, changing workspaces, closing tabs where necessary, and desktop shutdown. Workspace session persistence uses its own ordered queue so stale tab state cannot overwrite newer state.

## Atomic writes and backups

Server and local-browser writes use replacement rather than editing a file in place. Before destructive changes, the previous file is copied into `.math-note-backups/` while preserving its relative path.

Backup restore swaps the selected backup with the current file, making the operation reversible. Legacy backup locations are migrated when possible. The desktop application also writes its workspace preference atomically in the operating system’s application-data directory.

## Search and navigation

Search ranks title, label, prefix, recency, and natural-number matches. It supports opening an existing block or creating an exact validated label.

Tabs keep independent nested-focus state. Closing and reopening a tab restores its former position. Desktop commands and configurable shortcuts cover tab cycling, reopen, metadata editing, search, and nearest-parent navigation.

Backlinks are not stored as authored edges. They are derived from current reference data and grouped by source block, with repeated-mention counts and on-demand excerpts.

## Blocks View

Blocks View combines two structures without treating them as the same graph:

- The left pane uses label hierarchy as a stable backbone.
- The right pane shows the selected block’s parent, children, references, and backlinks.

Virtual namespaces explain missing path segments. Search preserves ancestors unless “matches only” is selected. Health filters cover empty blocks, broken references, duplicates, and isolation.

The hierarchy list is virtualized for large workspaces. Its viewing breadcrumb follows the branch crossing the list’s reading line. The relationship map supports pan, zoom, node dragging, keyboard selection, and full long titles. Multiple relationships share one node placement while retaining the necessary directed edges.

## Graph View

Graph View is an optional workspace-wide reference visualization powered by `react-force-graph-2d`. It is useful for global topology, while Blocks View is optimized for structural location and local inspection. The feature is loaded only when opened.

## Assets

Pasted images open an asset dialog and are stored below `assets/`. Markdown uses portable workspace-relative paths. Server paths are normalized, traversal is rejected, and upload content must be a valid data URI. Browser viewer mode creates object URLs for imported assets without writing them.

## Settings and workspace sessions

Workspace settings include macros, autocomplete entries, keyboard shortcuts, and visual preferences. Open tabs and the active tab are persisted separately as session state.

Settings, search, image upload, workspace diagnostics, safe relabel, Blocks View, and Graph View are lazy-loaded. Escape remains functional while a module is loading, and focus returns to the control that opened a dialog.

## Desktop lifecycle and security

Electron starts the bundled local server on a loopback port and loads that origin in the application window. The preload exposes a narrow desktop API for commands, workspace selection, shutdown preparation, and revealing files.

The window may navigate only within its application origin. External HTTP, HTTPS, and mail links are denied in the embedded window and opened through the operating system. Closing the window first asks the renderer to flush pending writes before the server and application exit.

## Server API boundaries

`server.ts` provides endpoints for:

- Runtime capabilities.
- Block metadata, content, creation, update, deletion, and raw Markdown.
- Safe relabel preview and commit.
- Duplicate-label repair.
- Assets.
- Settings and workspace session state.
- Backup listing and restoration.
- Server-Sent Events.

All workspace-relative filesystem paths are normalized and checked before access. Test-only reset and fixture endpoints exist only in test mode.

## Build, caching, and delivery

Vite builds the client and PWA. Express is bundled separately for Electron. Optional interfaces are split into lazy chunks. `npm run build:analyze` generates a bundle treemap for tracking initial-load cost.

The service worker precaches the built application. GitHub Pages publishes the static version, while the desktop workflow tests and packages Linux, macOS, and Windows builds.

## Verification

```bash
npm run lint
npm run test:e2e
npm run test:atomic-saves
npm run test:desktop-server
npm run build:desktop
```

The browser suite covers recursive editing, focus navigation, lazy loading, safe relabeling, duplicate repair, save serialization, backups, assets, Blocks View, large workspaces, and accessibility. Safe-relabel tests exercise structural transformations and rejection cases independently. Atomic-write and desktop-server smoke tests cover the storage and packaging boundaries.

## Main technologies

- React and Zustand
- CodeMirror 6 and Lezer
- KaTeX
- Vite and vite-plugin-pwa
- Express
- Electron
- Playwright
