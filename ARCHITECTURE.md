# Living Specification & Architecture

## 1. Core Architecture & Tech Stack

**Frameworks & Libraries:**
*   **React (Vite):** Core UI framework for component rendering and lifecycle management.
*   **Zustand:** Provides a lightweight, unopinionated global store for the block state.
*   **CodeMirror 6:** The primary text engine for code editing, syntax highlighting, and text processing.
    *   **Packages:** `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown`, `@codemirror/theme-one-dark`, `@codemirror/commands`, `@codemirror/autocomplete`
*   **KaTeX:** Library for rendering $\LaTeX$ equations quickly and consistently across browsers.
*   **Tailwind CSS:** Used for consistent styling, utility classes, and layout execution.
*   **@hello-pangea/dnd:** Robust drag-and-drop mechanics for reordering components.
*   **Lucide React:** Iconography.
*   **Express (Backend):** Lightweight Node.js server handling API endpoints and Vite development middleware.
*   **gray-matter:** Used on the backend to parse and stringify Markdown blocks with YAML frontmatter.

**Architectural Pattern:**
*   **Local File-Based Storage Engine:** The application functions as a local desktop-like editor. Instead of a database, blocks are stored as individual `.md` files within a local `blocks/` directory. Each `.md` file represents a block, storing metadata (title, label) within YAML frontmatter and the actual text in the Markdown body.
*   **Block-Based Editable Nodes:** The application utilizes a split-state UI where content is chunked into logical "Blocks" managed by global state (Zustand) and persisted via API endpoints (`GET/POST/PUT/DELETE /api/blocks`).
*   **State-Driven Editor Decoration Architecture:** CodeMirror state fields and widget decorations respond reactively to text and cursor positions. For math components, CodeMirror `WidgetType`s (`MathWidget`, `BlockMathEditingPreviewWidget`) swap out raw $\LaTeX$ delimiters for HTML snippets parsed via `katex.render`.
*   **Latex Autocompletion:** A custom snippet autocomplete logic (`latexCompletion`) hooked into `@codemirror/autocomplete` to provide rapid entry for complex math environments (e.g. `\pmatrix`).
*   **Tooltip Engine for Inline Overlaps:** A custom CodeMirror `showTooltip` implementation evaluates inline math overlaps to render error states or floating preview boxes without disrupting the text flow.

## 2. The Data Model

**Global Store (`useStore` from `src/store/index.ts`)**
*   **`blocks: Block[]`**: The primary array holding the document state, synced with the backend via `fetch()`. Contains async actions (`loadBlocks`, `addBlock`, `updateBlock`, `deleteBlock`).
*   **`activeBlockId: string | null`**: Tracks which block currently holds focus.
*   **`macros: Record<string, string>`**: Global KaTeX macro definitions shared across all blocks.
*   **`focusDirection: "start" | "end" | null`**: Transient state communicating whether a newly focused block should place the cursor at the top padding (`0`) or bottom padding (`length`), triggered via keyboard navigation.

**`Block` Entity Structure (Frontend & Backend `gray-matter` Markdown)**
*   `id: string`: Unique identifier (derived from the `.md` filename).
*   `title: string`: A user-defined heading or summary for the block (Stored in YAML Frontmatter). Defaults to "Untitled".
*   `label: string`: An optional tag or categorization (Stored in YAML Frontmatter). Defaults to "label".
*   `content: string`: The raw CodeMirror text content (including markdown/$\LaTeX$) representing the block's body (Stored as Markdown body).

## 3. Completed Features & Capabilities

**Block Management:**
*   **Dynamic Creation:** Users can add a new block.
*   **Metadata Editing:** Users can edit the `title` and `label` (meta fields) of individual blocks via a direct inline-editor overlay logic (Double click triggers `isEditingMeta` state).
*   **Deletion:** Individual blocks can be removed when hovered (Trash icon).
*   **Reordering:** Blocks can be dragged and dropped into new positions.

**Block Embeddings (`[[label]]` Syntax):**
*   **Inline & Standout:** Embeds can be evaluating inline (e.g., `[[label]]`) inside normal text flow, or rendered as a standalone block (e.g., `[[@label]]`).
*   **Open vs Closed State:** Embeds can be 'closed' (showing only the title/alias and rendering as a compact chip) or 'open' (e.g., `[[label∨]]` or `[[@label∨]]`) which expands the referenced block's body within the view. Clicking the title toggles this state smoothly without disrupting layout focus.
*   **Aliasing:** Supports custom display text via the pipe syntax (`[[label | Custom Alias]]`).
*   **Creation on Demand:** Toggling open an embed using the `Enter` shortcut pointing to a non-existent label will seamlessly create the block and shift focus into it.
*   **Relative Paths:** Embeds can reference child blocks via relative paths (e.g., `[[/child_label]]` resolves against a parent's namespace).
*   **Recursive / Cycle Detection:** Tracked via `visitedLabels` context to prevent rendering an infinite recursive block inclusion.
*   **Render Pipeline:** CodeMirror uses a custom `MatchDecorator` (`embedDecorator`) to parse the syntax and swap text for interactive React `WidgetType` elements (`EmbedWidget`), executing a lookup against the global Zustand store to fetch the target block's text and metadata.

**Typing & Text Engine:**
*   **CodeMirror Integration:** Robust editable surface. The editor supports standard Markdown syntax and bindings.
*   **Custom Keymaps:** Navigation rules specific to CodeMirror's viewport constraints (jumping between blocks bounds).
*   **Autocompletion:** A custom snippet autocomplete for LaTeX commands. Triggered conventionally, replacing trigger text with scaffolded `\begin` sequences.
*   **Bracket Autoclosure:** Automatic closing of `(`, `[`, `{`, `'`, `"`, and specifically `$`.

**UI & Rendering:**
*   **KaTeX Block & Inline Renderers:** Seamlessly identifies `$$` block boundaries and `$` inline boundaries.
*   **Dynamic Widget Replacement:** 
    *   When blurred, blocks evaluate equations natively using `katex.render`. 
    *   When focused, block math creates *below-the-line* live preview tooltips (`BlockMathEditingPreviewWidget`).
    *   Inline math creates floating tooltips above the cursor if overlapped. 
*   **Focus-Based UI Transitions:** Smooth CSS transitions for the outer generic `BlockContainer` showing an active outline vs idle outline.
*   **Syntax Highlighting:** Live regex parsing maps specific text tokens (Command `\something`, Braces `{}`, Symbols `_`, `^`, `&`) to specific color mappings to mimic overleaf/latex environments *while* editing inside the raw text.

## 4. Interaction Flows & Rules (The Mechanics)

**Mouse Mechanics:**
*   **Focus Swap (Blocks):** Clicking within a block area sets `activeBlockId` to that block's `id`.
*   **Meta Edit:** Double-clicking the Top-Bar of a block enters the title/label editing mode, rendering input boxes.
*   **Outside Click / Blur:** CodeMirror listens for `update.focusChanged && !update.view.hasFocus` specifically to fire `onBlurRef.current()`, saving content up to `useStore()`.
*   **Cursor Desync Guard Mechanism:** `isGlobalMousePressed` is tracked globally via `mousedown`/`mouseup` listeners. When a `focus` event hits CodeMirror during a mouse press, it defers evaluating the exact target index until the layout finishes shifting and `mouseup` completes, guaranteeing accurate pointer placement, preventing jumping cursor bugs when collapsing math widgets into raw text.

**Keyboard Mechanics:**
*   **`ArrowUp` (Inter-Block):** Handled via `blockNavigation`. If at index `0` of the CodeMirror document (or visually the top line), triggers `onUp()` moving focus to the `end` of the previous block.
*   **`ArrowDown` (Inter-Block):** If at the maximum length of the CodeMirror document, triggers `onDown()` moving focus to the `start` of the subsequent block. If on the final block, spawns a new block automatically.
*   **Meta Submits (`Enter` / `Escape`):** While editing the Title/Label, `Enter` submits the form and `Escape` reverts it to its original text.

## 5. Current State & Recent Fixes
  
**Local Desktop App Capabilities:**
*   **File-Backed Storage:** Configured an Express/Vite backend serving the API out of `server.ts`. 
*   **Automatic Syncing:** The Zustand store optimistically updates on typing and debounces PUT requests back to the local backend.
*   **Raw File Inspection:** Added an explicit feature to inspect raw Markdown file output per component (`/api/blocks/:id/raw`).

**Recent visual/rendering & accessibility fixes:**
*   Fixed a subtle cursor focus desync related to clicking rendered blocks by explicitly intercepting the global mouse events. Delayed the CodeMirror `focus` handler so that CodeMirror has enough layout ticks to correctly register its `mouseup` spatial coordinates *after* the DOM restructuring.
*   Introduced the `mathTooltip` feature to solve inline math editing context, maintaining a reactive preview right above the cursor without breaking layout flow.
*   Enhanced visual contrast for text selection highlighting across both markdown and text elements.
*   Corrected CSS overlap bugs causing tooltip clipping by strategically assigning `overflow: visible` and managing z-indices in CodeMirror viewports.
*   Optimized Embedded Block widget lifecycle so changes in position do not cause UI flashes, and interaction handlers smoothly create blocks and toggle view states without unexpected cursor behaviors.

**Immediate Next Steps**
1.  **Refine Navigation State:** Ensure that shifting focus via Mouse Click vs Arrow Navigation does not race the UI state (e.g., `window.addEventListener` should not interfere with standard tab ordering).
2.  **Debounced Persistance Improvements:** Enhance the `PUT /api/blocks/:id` mechanism to be more robust for high-frequency typing over the network, or implement WebSocket sync.
3.  **Local App Packaging:** Prepare paths/build steps to eventually run as an Electron wrapper or locally executed lightweight Node server.
