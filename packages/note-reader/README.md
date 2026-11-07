# Shared published note reader

`index.mjs` is the read-only Markdown-to-HTML adapter used by the personal website. It imports the same `note-display-core.mjs` parser and title rules as the editor. The editor still owns CodeMirror focus, selection, and editing; the reader receives a workspace's parsed notes and returns rendered HTML plus references/backlinks.

The website pins this repository as a Git submodule. When changing embedded syntax or title presentation, update the core module here and its tests, then advance the website's submodule pointer. Structural embed classes (`embed-title`, `note-embed`, `inline-embed`, `standout-embed`) are stable; the consumer sets its own CSS variables for colours, padding, title size, and indentation.

The reader uses the consuming application's `markdown-it`, `katex`, and `sanitize-html` dependencies. Do not render untrusted HTML without the sanitizer in `index.mjs`.
