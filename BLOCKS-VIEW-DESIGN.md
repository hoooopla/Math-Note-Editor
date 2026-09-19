# Blocks View: structure first, relationships on demand

## 1. Conceptual model

A block has a stable identity, a human title, a label locating it in a namespace, and authored content. Titles may be arbitrarily descriptive and include mathematics. Labels are addresses, not identities. Renaming an address should preserve the selected block's identity and trigger reference validation.

Two structures coexist. The label tree answers “Where does this live?” The directed reference graph answers “What is related to this?” Neither is an accurate replacement for the other. A reference is not necessarily a logical prerequisite: a proof may cite an example, motivation, or counterexample. Do not label ordinary reference reachability as verified mathematical dependency.

An actual parent is the nearest unambiguous existing ancestor. Namespace rows can fill gaps in the visible outline without claiming that an authored block exists there. A namespace can also contain a real note at its own path.

```
analysis                 real note
└ sequences              namespace only (outline folder)
  └ convergence          real note
      ↑ actual parent: analysis

Reference graph, independently:
definition → theorem ⇄ lemma → missing target
                ↺ self-reference
```

The hierarchy-first principle is appropriate when labels are maintained and meaningful. It fails as a complete organizing principle when most notes have flat labels, when the hierarchy is arbitrary, or when the user's question concerns logical relationships. Keep Index and Connections one click away; do not force references into tree parenthood. Preserve the separate global Graph View for broad exploration.

## 2. Comparing layouts

Common reference conventions in this comparison: one directed relationship per ordered pair; ×N means occurrences, not distinct neighbors; incoming arrows are backlinks; a dashed missing-target stub is not a real note; cycles are valid unless a separately declared dependency model forbids them. No overview draws every reference by default.

| Layout | Best question; hierarchy | References / backlinks and exceptional topology | Long labels and missing intermediates | Strength / failure |
|---|---|---|---|---|
| Hierarchical tree | Where is a note? Indentation and expand/collapse follow namespaces. | Counts then inspector; missing targets in diagnostics; cycles and self-links remain in inspector; repeated links aggregate; disconnected reference components still share their structural homes. | Virtual namespace rows, full path in inspector; clip row titles, wrap selection. | Stable and keyboard-friendly; conceals graph patterns and can become very tall. |
| Layered hierarchy graph | How do nearby branches relate structurally? Parents occupy stable layers. | Selected dashed directed edges only; missing stubs; self-loop glyph; reciprocal edges distinguished; ×N; disconnected references do not change placement. | Virtual junctions or compressed paths; wide long-title cards consume horizontal space. | Makes parenthood spatial; broad branches and deep paths cause enormous canvases and edge crossings. |
| Pure reference graph | What clusters are linked? Hierarchy becomes breadcrumb metadata. | Directional edges, missing stubs, explicit loops and reciprocal arcs; parallel mentions aggregate; disconnected components occupy separate islands. | No virtual nodes needed; labels only on selection or at close zoom. | Discovers connections; auto-layout moves notes, hides hierarchy, and turns hubs into hairballs. |
| Radial / ego view | What is immediately related to this note? Hierarchy lives in inspector. | Incoming and outgoing sectors; paged neighbors; missing targets in a separate sector; center self-loop; reciprocal badges; ×N. Other disconnected components are outside scope, explicitly announced. | Titles in lists next to sectors; missing intermediate labels only in breadcrumb. | Fast local exploration; high-degree hubs crowd the perimeter and repeated re-centering loses orientation. |
| Nested namespace groups | Which subjects occupy the workspace? Containment is hierarchy. | Aggregate cross-group counts; references revealed on selection; missing counts per group; cycles and self-links described inside inspector; unrelated components can coexist in a group. | Virtual containers are natural; long group names need wrapping; tiny nested rectangles cannot carry theorem titles. | Good distribution overview; area can falsely imply importance and conceal small namespaces. |
| Sortable index | Find, compare, or audit notes. Full path column preserves location. | Incoming/outgoing counts and diagnostic columns; selection reveals missing targets, loops, cycles, ×N. Disconnected notes are ordinary rows. | No virtual rows; full searchable path plus selected wrap. | Best for precise search, sorting, large audits; least spatial and does not express branch shape. |
| Split hierarchy + inspector | Where is it, and what is related? Outline supplies stable placement. | Selected incoming/outgoing lists, namespace groups and progressive expansion; missing and ambiguous targets separated; self/cycle navigation allowed; occurrences aggregate. Disconnected notes remain findable in structure. | Virtual namespace rows; compact titles in outline, complete title/path in inspector. | Best default balance; width competition and a hidden selection require explicit reveal/context actions. |
| Reference trace | What references this, directly or indirectly? Hierarchy is breadcrumb metadata. | Directed breadth levels; visited notes appear once at shortest distance; repeat marker for cycles/self/shared paths; ×N stays in inspector; missing outgoing references remain diagnostics. Disconnected components are excluded by definition. | Wrap selected title; other titles in paged level lists; missing namespace segments do not change hop count. | Useful for mathematical reasoning; reachability must not be mistaken for proof dependency or topological ordering. |

### Scale by layout

| Layout | 100 blocks | 1,000 blocks | 10,000 blocks |
|---|---|---|---|
| Tree | Expand a few branches | Collapse by namespace, virtualize rows | Virtualize, search, cap indentation, avoid “expand everything” default |
| Layered graph | One or two branches | Branch-level aggregation | Local branch canvas only; whole-workspace cards are unusable |
| Reference graph | Selected edges still preferable | Clusters, bounded neighbors | Component summary followed by a local neighborhood |
| Ego view | One-hop neighborhood | Degree caps and namespace grouping | Same bounded local view; never place all backlinks on a circle |
| Nested groups | Readable groups | Collapse subgroups | Namespace counts, drill down; no thousands of tiny titled cells |
| Index | Rows and sorting | Virtual rows | Virtual rows and indexed metadata; avoid loading all note content |
| Split view | Full selected inspector | Virtual outline and paged neighbors | Same bounded rendering, metadata graph built once per revision |
| Trace | A few levels | Limit hops and list entries | Bounded depth, cycle termination, grouped frontier and progressive detail |

## 3. Recommended default

Use a split hierarchy outline and relationship inspector. Avoid duplicating the same tree in a sidebar and a second large canvas. Keep ordinary scrolling and legible type. Spatial continuity comes from stable sibling order, indentation, selection, and breadcrumbs rather than movable graph coordinates.

```
┌ Search title or label ───── State / Namespace / References ┐
│ Structure | Connections | Index | Reference trace          │
│ Filtered: 1 / 360 matches · ancestors retained · Clear      │
├──────────────────────────────┬──────────────────────────────┤
│ ▾ analysis       context     │ Full mathematical title      │
│   ▾ sequences    namespace   │ Full label + breadcrumbs     │
│     ▾ convergence namespace  │ Open | Reveal in structure   │
│       uniform    SELECTED    │ Nearest actual parent        │
│                              │ Children                     │
│                              │ Backlinks (grouped, paged)   │
│                              │ References + ×N mentions     │
│                              │ Missing / ambiguous targets  │
│                              │ Note preview                 │
└──────────────────────────────┴──────────────────────────────┘
```

A canvas is helpful when geometry itself conveys structure, but this workspace's primary task is locating and inspecting long mathematical notes. A nested map overemphasizes area and sacrifices readable titles. An ego diagram is valuable locally but unsuitable as a stable home. The split outline is the primary home; relationship modes complement it.

## 4. Modes based on intent

- **Structure:** Where does this note belong? Expand namespaces and inspect the actual parent.
- **Connections:** What points here, and what does this point to? Selected note between incoming and outgoing lists. Lists remain useful at high degree where radial nodes would collide.
- **Index:** Find a precise note or inspect workspace health; sort labels, titles, or backlink counts.
- **Reference trace:** Follow incoming or outgoing references through a chosen number of steps. Cycles terminate; a repeated-visit marker does not claim to diagnose a strongly connected component.

An eventual “Map” should be a namespace overview with counts, not another unrestricted graph. Do not add more modes until usage demonstrates a distinct question they answer.

## 5. Interaction model

Single click selects and keeps Blocks View open. Double click, Enter on a note row, or Open block enters the actual note. Space selects a focused row. Up/Down moves focus; Right expands; Left collapses. Tab traverses controls with visible focus. Escape closes and restores focus to the opener.

Clicking a relationship selects that note in the same inspector. Back returns through the selection history; Reveal in structure clears filters, expands ancestors and scrolls the selected note into view. Selecting a namespace filters/drills into structure; it never opens a phantom note. Actual-parent and child lists support direct structural navigation. Breadcrumbs disclose whether each segment is a note or namespace.

The selection is keyed by block ID across filters and modes. When filters exclude it, explicitly say so. Keep the selected title anchored in the inspector while lists change. Expansion state should survive reference exploration. A future complete navigation history should also snapshot filters, mode, expansion and scroll position; selection history alone is not a complete workspace undo mechanism.

## 6. Visual language and block information

Hierarchy uses quiet indentation, stable ordering and solid structural separators. Namespaces use outline folders and the text “namespace”; authored notes use a document icon. Empty real notes retain the document icon with an “empty” badge. Do not create faux missing notes to complete the outline.

References use direction words (Incoming / Outgoing), arrows and counts. If drawn, they should be light dashed curves, contrasting with solid rectilinear hierarchy lines. Backlinks are incoming edges, not a third relationship type. A duplicate-label conflict is a diagnostic grouping, never an authored edge.

At normal density: one-line rendered mathematical title, shortened full path, distinct backlink/outgoing counts and text state badges. On hover/focus: accessible full row label. On selection: full wrapping title/path, actual parent, children, exact targets, occurrence counts and preview. Long equations get their own overflow inside the inspector. Do not shrink text to make an arbitrary title fit.

Colors reinforce selection and problems but never carry their meaning alone. Selected rows have a border and accessible current state. Problems have text and symbols. Respect keyboard users, screen magnification and reduced-motion preferences; this design does not require animation to navigate.

## 7. Semantic density

Explicit density choices are more discoverable than interpreting a trackpad wheel as zoom:

| Level | Information |
|---|---|
| Workspace | Top-level groups and aggregate note counts; actual root notes remain distinguishable. |
| Branches | First branches plus namespace counts; expand locally. |
| Blocks | Readable note titles, paths, compact state and relationship counts. |
| Detail | More space for path information; selection supplies full title, preview and exact relationships. |

Do not merely scale the whole screen. Content density changes while inspector text remains legible. In a future canvas, thresholds should collapse blocks into namespace groups, with hysteresis to avoid flicker around zoom boundaries.

## 8. Search and filtering

Search matches title and full label. State, namespace and incoming/outgoing filters intersect. Search reveals ancestor paths and marks nonmatching ancestors “context.” Virtual namespaces remain clearly labeled. An explicit Matches only option removes context for auditing; Index is always flat. Report matches versus total workspace, not just the count of rendered rows.

Relationship inspection deliberately retains neighbors outside filters and announces that scope. A selected note outside filters remains in the inspector with a notice. Trace depth supplies a graph-distance scope, independently of hierarchy depth. Filters should never silently remove an intermediate step from a reference chain and falsely imply a direct edge.

Empty result states keep the selection and offer Clear filters. Search should not destroy manually expanded branches. A more advanced dim-only mode can preserve nonmatches for small branches, but showing 10,000 dimmed rows is not useful; ancestor retention is the default compromise.

## 9. Large workspace strategy

Render only a small viewport of outline/index rows. Load note content only for selection. Keep collapsed namespaces as counts. Group high-degree backlinks by namespace and show 12 initially, expanding 24 at a time. A hub with 200 backlinks must not draw 200 arrows. Five references from A to B are one neighbor with ×5 mentions.

Limit indentation after ten levels and preserve full path plus explicit depth; never let deep paths push note text offscreen. Very broad branches remain scrollable virtual lists. Highly uneven namespace sizes use counts, not proportional giant cards. Disconnected reference islands do not need synthetic connections; they remain ordinary structural entries. Flat workspaces can switch to Index.

Reference traces are bounded by hops, stop revisits, and paginate level lists. Larger deployments may need cancellable background graph calculations and indexed search; virtualization bounds rendered content but does not eliminate the cost of reading and analyzing metadata.

## 10. Exceptional cases

**Missing path segments:** Flattening loses meaningful subject context; directly attaching to the nearest actual ancestor gives truthful parenthood but hides gaps. Recommend virtual rows for every missing path segment, with the actual parent separately stated. Compressed chains can later shorten extreme depths without inventing blocks.

**Empty:** A valid note with no non-whitespace content. This is not a missing target or a namespace. Future rich-content emptiness rules must agree with editor semantics.

**Broken:** A missing target is a relationship problem; show the offending label under the source. A duplicated target label is ambiguous, not missing. Keep those diagnoses separate even if both share an “Unresolved references” filter.

**Duplicate:** Exact conflicting labels are deterministic. Identical titles or mathematical statements are only possible duplicates and must never be merged automatically. Show candidates with IDs where needed; repair must be explicit.

**Orphan:** Avoid calling every top-level note an error. “No reference connections” means neither incoming nor outgoing relationships, including unresolved outgoing attempts. “Fully isolated” additionally means no actual parent or children. A namespace gap is not an orphan. Roots are ordinary structure, not a diagnostic.

**Cycles:** A self-reference gets a loop label. Two-way relationships are visible in both directional lists. Larger cycles are safe to follow with history; trace stops visited nodes. Strongly connected components could be collapsed as “mutually reachable groups” in an advanced dependency mode, but must not be called errors or given an arbitrary proof order. The current trace does not claim SCC analysis.

**Repeated references:** Distinct-target counts are separate from occurrence counts. Metadata may deduplicate references, so occurrence counts come from the selected source's full content. Inbound occurrence totals require reading those sources; do not fabricate them from backlink counts.

## 11. Mental-map preservation

Stable lexical sibling ordering prevents graph re-layout during inspection. Selection persists through mode/filter changes; full paths and the inspector anchor identity. Search retains ancestors and does not mutate stored expansions. Reveal gives an explicit return to structural position. Back follows selections without opening notes. Avoid automatic centering every time a relation is selected.

There are tradeoffs: a filtered outline compacts rows and semantic density changes row heights. Per-mode scroll offsets are preserved when switching modes; Reveal anchors by selected ID. Pinning and complete viewport history are sensible follow-ups, not requirements to draw a usable default. Selection history does not restore every previous filter and viewport.

## 12. Risks and safeguards

- Renames can leave stale label references; revalidate through the existing safe-relabel workflow. The block ID remains the selection key.
- Duplicate ancestor labels make actual parenthood ambiguous. Do not arbitrarily select one candidate. Visual namespace containment can remain while the actual-parent inspector skips the ambiguous ancestor.
- Same final segments in different subjects require visible full paths; truncating every row to “convergence” is inadequate.
- A real note at a namespace path must both select and expand. Separate the disclosure control from the note action.
- Progressive disclosure can hide important problems. Keep state badges and counts visible; diagnostics reveal exact labels.
- Reference counts are not importance, correctness, or proof status. Avoid sizing theorem cards by popularity.
- Selection appearing in both a list and an inspector must have one ID and one highlight semantics. Relation aliases never create another note identity.
- Search results are a subset. Keep the active-filter banner and clear action visible.
- Invalid math should remain readable rather than crashing the view. All math rendering follows existing MathTitle behavior.
- Very long or malicious labels, whitespace-only content, Unicode, case distinctions and renamed references need validation independent of visual layout.
- Narrow screens stack inspector below structure; neither region should consume the entire viewport. Touch cannot rely on hover.
- Do not automatically open every referenced note: cycles and high fan-out can otherwise trigger unbounded previews.

## 13. Recommendation and delivery scope

Default to a virtualized hierarchy outline with an always-available selected-note inspector. Use local Connections, sortable Index and bounded Reference trace as the alternative modes. Distinguish namespace, note and unresolved target explicitly. Favor readable titles, stable selection and bounded relationship lists over whole-workspace edge drawings.

This implementation provides those four modes, density choices, ancestor-preserving search, state/namespace/reference filters, full selected titles, previews, virtual rows, grouping, repeated outgoing mention counts, selection history and reveal. It does not implement a new global canvas, SCC visualization, verified proof-dependency semantics, fuzzy duplicate detection, pinning, or full viewport-history snapshots.

The deterministic test fixture covers 360 notes, a 222-backlink hub, a broad branch, 32 intermediate path levels, missing/ambiguous references, duplicate labels, repeated mentions, self/two-way/three-way cycles, relative references, Unicode, long titles, identical final names, empty and isolated notes, disconnected groups and a 25-note chain. Browser tests also generate 10,000 notes to verify bounded row rendering. Fixture insertion is available only in test mode and does not write note files.

### Validation

Twelve targeted checks passed: fixture topology; ancestor retention and opening; diagnostic filters and selection retention; occurrence aggregation and connection history; bidirectional cyclic trace; 10,000-note virtualization/sorting/reveal; narrow-screen long titles and deep paths; keyboard/filter interactions; 1,000-note scroll restoration; existing model derivation; existing backlink navigation; existing Blocks View/Graph View separation. TypeScript checking and the production build passed. The build reports the existing large-bundle advisory. These checks exercise the listed scenarios, not every possible input or browser.

The review server uses port 3001 because 3000 was already occupied. It contains the 360 generated examples alongside the existing in-memory workspace notes. Search `atlas/` to focus on generated subjects, or `isolated-example` for the fully isolated example. Reloading the app may display the expected duplicate-label warning; choose Review later to inspect the examples without repairing them. Test-mode edits disappear when the server stops.
