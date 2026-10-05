import { Decoration, DecorationSet, EditorView, WidgetType, showTooltip, Tooltip, KeyBinding } from "@codemirror/view";
import { EditorSelection, RangeSetBuilder, StateField, Facet } from "@codemirror/state";
import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { editorFocusField, parsedRangesField, setEditorFocus } from "./katex-plugin";
import { Root, createRoot } from "react-dom/client";
import { EmbeddedBlockUI } from "../../components/EmbeddedBlockUI";
import React from "react";
import { useStore } from "../../store";
import { EmbeddedLinkSyntax, parseEmbeddedLinks, parseEmbeddedText, resolveEmbeddedLabel, setEmbeddedOpen } from "../embedded-link-syntax";
import { EmbeddedObjectSelection, setEmbeddedObjectSelection } from "./embedded-object-selection";
import { embeddedContentFingerprint, promoteEmbeddedOccurrence } from "../embedded-editor-lifecycle";
import { getEmbeddedPanelScrollVersion, isEmbeddedPanelScrolling, setEmbeddedPanelScrollTop } from "../embedded-scroll-coordinator";

export { setEmbeddedObjectSelection } from "./embedded-object-selection";

export type ParsedLink = EmbeddedLinkSyntax & { occurrenceId: number };

let nextEmbeddedLinkOccurrenceId = 1;

function initiallyTrackedLinks(text: string): ParsedLink[] {
    return parseEmbeddedLinks(text).map(link => ({ ...link, occurrenceId: nextEmbeddedLinkOccurrenceId++ }));
}

export const parentLabelFacet = Facet.define<string, string>({
    combine: values => values[0] || ""
});

export const visitedLabelsFacet = Facet.define<string[], string[]>({
    combine: values => values[0] || []
});

export const occurrencePathFacet = Facet.define<string[], string[]>({
    combine: values => values[0] || []
});

function promoteTargetOccurrence(view: EditorView, targetBlockId: string, position: number) {
    const parentOccurrencePath = view.state.facet(occurrencePathFacet);
    const occurrenceKey = JSON.stringify([...parentOccurrencePath, `${targetBlockId}@${position}`]);
    promoteEmbeddedOccurrence(occurrenceKey);
    return occurrenceKey;
}

export const parsedLinksField = StateField.define<ParsedLink[]>({
    create(state) {
        return initiallyTrackedLinks(state.doc.toString());
    },
    update(value, tr) {
        if (tr.docChanged) {
            const next = parseEmbeddedLinks(tr.state.doc.toString());
            const oldByMappedStart = new Map<number, ParsedLink[]>();
            for (const link of value) {
                // A replacement of the link itself belongs to the old start;
                // an insertion immediately before it belongs to the new end.
                // Check both associations, but consume each old ID only once.
                for (const mappedStart of new Set([
                    tr.changes.mapPos(link.from, -1),
                    tr.changes.mapPos(link.from, 1)
                ])) {
                    const candidates = oldByMappedStart.get(mappedStart) ?? [];
                    candidates.push(link);
                    oldByMappedStart.set(mappedStart, candidates);
                }
            }
            const reused = new Set<number>();
            return next.map(link => {
                const candidates = oldByMappedStart.get(link.from);
                const matchingIndex = candidates?.findIndex(previous =>
                    !reused.has(previous.occurrenceId) &&
                    previous.label === link.label && previous.relative === link.relative &&
                    previous.alias === link.alias && previous.standout === link.standout
                ) ?? -1;
                const previous = matchingIndex >= 0 ? candidates![matchingIndex] : undefined;
                if (previous) reused.add(previous.occurrenceId);
                return { ...link, occurrenceId: previous?.occurrenceId ?? nextEmbeddedLinkOccurrenceId++ };
            });
        }
        return value;
    }
});

const embedWrappersByView = new WeakMap<EditorView, Set<HTMLElement>>();
const lastVisualMoves = new WeakMap<EditorView, {
    direction: "up" | "down";
    from: import("@codemirror/state").SelectionRange;
    to: import("@codemirror/state").SelectionRange;
    doc: import("@codemirror/state").Text;
    fromVisual?: { x: number; y: number };
    fromObjectSelection?: EmbeddedObjectSelection | null;
}>();
type EmbeddedWidgetLayoutRecord = {
    height?: number;
    widthBucket?: number;
    snapshotHtml?: string;
};
const embeddedWidgetLayouts = new Map<string, EmbeddedWidgetLayoutRecord>();
const MAX_EMBEDDED_WIDGET_LAYOUTS = 1024;
const MAX_EMBEDDED_WIDGET_SNAPSHOTS = 128;
const explicitReopensByView = new WeakMap<EditorView, Map<number, number>>();
const EXPLICIT_REOPEN_SETTLE_MS = 1200;
let embeddedWidgetRevisionFrame: number | null = null;

function markExplicitReopen(view: EditorView, from: number) {
    const now = performance.now();
    const reopens = explicitReopensByView.get(view) ?? new Map<number, number>();
    for (const [position, expiresAt] of reopens) {
        if (expiresAt <= now) reopens.delete(position);
    }
    reopens.set(from, now + EXPLICIT_REOPEN_SETTLE_MS);
    explicitReopensByView.set(view, reopens);
}

function explicitReopenExpiry(view: EditorView, from: number) {
    const expiresAt = explicitReopensByView.get(view)?.get(from) ?? 0;
    return expiresAt > performance.now() ? expiresAt : 0;
}

function hasActiveExplicitReopen(dom: HTMLElement) {
    const reopen = dom.closest<HTMLElement>('[data-explicit-reopen-until]');
    return !!reopen && Number(reopen.dataset.explicitReopenUntil || 0) > performance.now();
}

function canSettleExplicitReopen(dom: HTMLElement) {
    if (!hasActiveExplicitReopen(dom)) return false;
    const editors = Array.from(dom.querySelectorAll<HTMLElement>('.cm-editor'))
        .filter(editor => !editor.closest('.cm-embedded-snapshot'));
    if (editors.length === 0) return false;
    // KaTeX emits source-less decorative <img> elements. Only a real note
    // image can still load and change the measured body height.
    if (Array.from(dom.querySelectorAll<HTMLImageElement>('img')).some(image =>
        image.hasAttribute('src') && (!image.complete || image.naturalWidth === 0)
    )) return false;
    return editors.every(editor => {
        const view = EditorView.findFromDOM(editor);
        return !!view && view.viewport.from === 0 && view.viewport.to === view.state.doc.length &&
            !Array.from(view.contentDOM.children).some(child => child.classList.contains('cm-gap'));
    });
}

function canRefineEmbeddedHeight(panel: HTMLElement | null, dom: HTMLElement) {
    if (!dom.isConnected) return false;
    if (!panel) return true;
    const viewport = panel.getBoundingClientRect();
    const rect = dom.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
}

if (typeof window !== "undefined") {
    window.addEventListener("math-note-workspace-reset", () => {
        embeddedWidgetLayouts.clear();
        if (embeddedWidgetRevisionFrame !== null) cancelAnimationFrame(embeddedWidgetRevisionFrame);
        embeddedWidgetRevisionFrame = null;
    });
}

function replaceEmbeddedWidgetHeight(key: string, height: number, widthBucket?: number) {
    if (!Number.isFinite(height) || height < 5) return;
    const record = embeddedWidgetLayouts.get(key) ?? {};
    record.height = Math.ceil(height);
    if (widthBucket !== undefined) record.widthBucket = widthBucket;
    embeddedWidgetLayouts.delete(key);
    embeddedWidgetLayouts.set(key, record);
    while (embeddedWidgetLayouts.size > MAX_EMBEDDED_WIDGET_LAYOUTS) {
        const oldest = embeddedWidgetLayouts.keys().next().value;
        if (oldest === undefined) break;
        embeddedWidgetLayouts.delete(oldest);
    }
}

function rememberEmbeddedWidgetSnapshot(key: string, html: string) {
    if (!html) return;
    const record = embeddedWidgetLayouts.get(key) ?? {};
    record.snapshotHtml = html;
    embeddedWidgetLayouts.delete(key);
    embeddedWidgetLayouts.set(key, record);
    while (embeddedWidgetLayouts.size > MAX_EMBEDDED_WIDGET_LAYOUTS) {
        const oldest = embeddedWidgetLayouts.keys().next().value;
        if (oldest === undefined) break;
        embeddedWidgetLayouts.delete(oldest);
    }
    let snapshotCount = 0;
    for (const item of embeddedWidgetLayouts.values()) {
        if (item.snapshotHtml) snapshotCount += 1;
    }
    if (snapshotCount > MAX_EMBEDDED_WIDGET_SNAPSHOTS) {
        for (const item of embeddedWidgetLayouts.values()) {
            if (!item.snapshotHtml) continue;
            delete item.snapshotHtml;
            snapshotCount -= 1;
            if (snapshotCount <= MAX_EMBEDDED_WIDGET_SNAPSHOTS) break;
        }
    }
}

function forgetEmbeddedWidgetSnapshot(key: string) {
    const record = embeddedWidgetLayouts.get(key);
    if (record) delete record.snapshotHtml;
}

function panelVisualAnchor(panel: HTMLElement) {
    const panelRect = panel.getBoundingClientRect();
    const x = panelRect.left + Math.min(160, panelRect.width / 3);
    const y = panelRect.top + Math.min(120, panelRect.height / 4);
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const hitAnchor = hit?.closest<HTMLElement>('[data-embed-nav-title="true"], .cm-line');
    if (hitAnchor && panel.contains(hitAnchor)) return hitAnchor;
    let nearest: { element: HTMLElement; distance: number } | null = null;
    panel.querySelectorAll<HTMLElement>('[data-embed-nav-title="true"], .cm-line').forEach(element => {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= panelRect.top || rect.top >= panelRect.bottom || rect.height <= 0) return;
        const distance = Math.abs(rect.top - y);
        if (!nearest || distance < nearest.distance) nearest = { element, distance };
    });
    return nearest?.element ?? null;
}

function commitEmbeddedHeight(panel: HTMLElement | null, dom: HTMLElement, height: number) {
    const anchor = panel ? panelVisualAnchor(panel) : null;
    const anchorTop = anchor?.getBoundingClientRect().top;
    dom.style.minHeight = `${height}px`;
    if (!panel || !anchor?.isConnected || anchorTop === undefined) return;
    // Reading the anchor after the style update forces this geometry change to
    // settle in the same task. Correct the panel before the browser paints so
    // nested height refinement cannot flash the visible text at the old offset.
    const visualDelta = anchor.getBoundingClientRect().top - anchorTop;
    if (Math.abs(visualDelta) > 0.5) {
        setEmbeddedPanelScrollTop(panel, panel.scrollTop + visualDelta);
    }
}

function captureEmbeddedWidgetSnapshot(mount: HTMLElement): string | null {
    // Editing decorations intentionally expose source text and may include a
    // composition/caret state that has no meaning after remounting. In that
    // case retain geometry only and wait for the real editor.
    if (mount.querySelector(".cm-math-editing, .cm-embedded-editing")) return null;

    const clone = mount.cloneNode(true) as HTMLElement;
    clone.querySelectorAll([
        ".cm-cursorLayer",
        ".cm-selectionLayer",
        ".cm-dropCursor",
        ".cm-tooltip",
        ".cm-panels",
        ".embedded-title-caret"
    ].join(",")).forEach(element => element.remove());
    clone.querySelectorAll<HTMLElement>(".cm-focused, .cm-activeLine, .cm-activeLineGutter, .cm-embedded-object-selected")
        .forEach(element => {
            element.classList.remove("cm-focused", "cm-activeLine", "cm-activeLineGutter", "cm-embedded-object-selected");
        });
    clone.querySelectorAll<HTMLElement>("[data-embed-keyboard-selected]").forEach(element => {
        element.removeAttribute("data-embed-keyboard-selected");
        element.style.removeProperty("outline");
        element.style.removeProperty("outline-offset");
    });
    clone.querySelectorAll<HTMLElement>("[contenteditable]").forEach(element => {
        element.removeAttribute("contenteditable");
    });
    return clone.innerHTML;
}

useStore.subscribe((state, previousState) => {
    if (state.blocksRevision === previousState.blocksRevision && state.blocksById === previousState.blocksById) return;
    if (typeof document === "undefined") return;
    if (embeddedWidgetRevisionFrame !== null) cancelAnimationFrame(embeddedWidgetRevisionFrame);
    embeddedWidgetRevisionFrame = requestAnimationFrame(() => {
        embeddedWidgetRevisionFrame = null;
        document.querySelectorAll<HTMLElement>('.cm-embedded-block-wrapper[data-standalone-embed="true"]')
            .forEach(widget => (widget as any).__beginEmbeddedLayoutChange?.());
    });
});

function embeddedTreeFingerprint(label: string, visited = new Set<string>(), depth = 0): string {
    const store = useStore.getState();
    const blockId = store.blockIdByLabel[label];
    const block = blockId ? store.blocksById[blockId] : undefined;
    if (!block || visited.has(block.id) || depth >= 24) {
        return embeddedContentFingerprint(`${blockId || label}:${block?.title || ""}`);
    }
    const nextVisited = new Set(visited);
    nextVisited.add(block.id);
    const content = block.content || "";
    const descendants = parseEmbeddedLinks(content).map(link => {
        const childLabel = resolveEmbeddedLabel(link, label);
        const childId = store.blockIdByLabel[childLabel];
        const child = childId ? store.blocksById[childId] : undefined;
        return link.open
            ? `${childLabel}:${embeddedTreeFingerprint(childLabel, nextVisited, depth + 1)}`
            : `${childLabel}:${embeddedContentFingerprint(`${childId || ""}:${child?.title || ""}`)}`;
    }).join("|");
    return embeddedContentFingerprint(`${block.id}:${block.title}:${content}:${descendants}`);
}

function preserveEmbeddedTogglePosition(view: EditorView, position: number, initialY: number) {
    // Nested widgets can change by hundreds of pixels without changing the
    // surrounding line count. Force CodeMirror to refresh its viewport before
    // asking for the replacement title's coordinates.
    const scrollContainer = view.dom.closest<HTMLElement>('[role="tabpanel"]');
    const scrollVersion = scrollContainer ? getEmbeddedPanelScrollVersion(scrollContainer) : -1;
    view.requestMeasure();
    requestAnimationFrame(() => {
        view.requestMeasure();
        const newY = view.coordsAtPos(position)?.top || 0;
        if (!initialY || !newY || newY === initialY) return;
        if (scrollContainer && getEmbeddedPanelScrollVersion(scrollContainer) === scrollVersion) {
            setEmbeddedPanelScrollTop(scrollContainer, scrollContainer.scrollTop + newY - initialY);
        }
    });
}

function registerEmbedWrapper(view: EditorView, dom: HTMLElement) {
    let wrappers = embedWrappersByView.get(view);
    if (!wrappers) {
        wrappers = new Set();
        embedWrappersByView.set(view, wrappers);
    }
    wrappers.add(dom);
}

function unregisterEmbedWrapper(view: EditorView | null, dom: HTMLElement) {
    if (!view) return;
    embedWrappersByView.get(view)?.delete(dom);
}

function rememberVisualMove(
    view: EditorView,
    direction: "up" | "down",
    from: import("@codemirror/state").SelectionRange,
    to: import("@codemirror/state").SelectionRange,
    fromVisual?: { x: number; y: number },
    fromObjectSelection?: EmbeddedObjectSelection | null
) {
    // Focus bookkeeping can legitimately dispatch a state transaction between
    // two key presses. Keep the immutable document identity plus the exact
    // destination instead of the whole EditorState, and clear this record from
    // pointer/non-vertical-key handlers below. That makes Up/Down reversal
    // deterministic without surviving an edit or a separate user gesture.
    lastVisualMoves.set(view, { direction, from, to, doc: view.state.doc, fromVisual, fromObjectSelection });
}

export function clearEmbeddedVisualMove(view: EditorView) {
    lastVisualMoves.delete(view);
}

function getEmbeddedObjectSelection(state: import("@codemirror/state").EditorState): EmbeddedObjectSelection | null {
    if (!state.field(editorFocusField, false)) return null;

    const selection = state.selection.main;
    if (!selection.empty) return null;

    for (const link of state.field(parsedLinksField)) {
        if (selection.head === link.from) {
            return { from: link.from, to: link.to, edge: "before" };
        }
        if (selection.head === link.to) {
            if (link.open) {
                const line = state.doc.lineAt(link.to);
                // With an expanded body at link.to, this document position is
                // shared by the title's after-edge and the continuation's
                // first character. A pointer/native selection at the boundary
                // belongs to the visible suffix; title selection is supplied
                // explicitly by the visual navigation commands.
                if (state.doc.sliceString(link.to, line.to).trim().length > 0) return null;
            }
            return { from: link.from, to: link.to, edge: "after" };
        }
    }
    return null;
}

/**
 * Keeps object selection separate from raw-source editing. The positions are
 * rebuilt from the transaction's current parsed links, so they remain valid
 * when an edit changes the length of an embed before the selected occurrence.
 */
export const embeddedObjectSelectionField = StateField.define<EmbeddedObjectSelection | null>({
    create(state) {
        return getEmbeddedObjectSelection(state);
    },
    update(value, tr) {
        const explicitSelection = tr.effects.find(effect => effect.is(setEmbeddedObjectSelection));
        if (explicitSelection) return explicitSelection.value;
        if (tr.docChanged || tr.selection) {
            return getEmbeddedObjectSelection(tr.state);
        }
        if (tr.effects.some(effect => effect.is(setEditorFocus))) {
            const wasFocused = tr.startState.field(editorFocusField, false);
            const isFocused = tr.state.field(editorFocusField, false);
            if (!wasFocused && isFocused) return getEmbeddedObjectSelection(tr.state);
            if (!isFocused) return null;
            // A repeated DOM/programmatic focus event must not turn an
            // explicitly cleared boundary caret back into a title selection.
            return value;
        }
        return value;
    }
});

function isRawEmbeddedSourceVisible(state: import("@codemirror/state").EditorState, link: ParsedLink) {
    if (!state.field(editorFocusField, false)) return false;
    const selection = state.selection.main;
    const cursorInside = selection.empty && selection.head > link.from && selection.head < link.to;
    const selectionOverlaps = !selection.empty && selection.from < link.to && selection.to > link.from;
    return cursorInside || selectionOverlaps;
}

/** Rendered embeds act as a single editor object. Direct boundary-arrow moves
 * may still enter the range, at which point this provider stops marking that
 * occurrence atomic and the raw [[...]] source becomes editable.
 */
export const embeddedAtomicRanges = EditorView.atomicRanges.of(view => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const link of view.state.field(parsedLinksField)) {
        if (!isRawEmbeddedSourceVisible(view.state, link)) {
            builder.add(link.from, link.to, Decoration.mark({}));
        }
    }
    return builder.finish();
});

/**
 * The title caret is a projection of an actual Markdown boundary. Browser DOM
 * selection cannot represent that boundary reliably when a block decoration
 * is mounted between the title line and the following source line, so route
 * text/IME/paste input through the logical edge instead of accepting the DOM's
 * occasionally remapped position.
 */
export const embeddedObjectInputHandler = EditorView.inputHandler.of((view, _from, _to, text) => {
    const objectSelection = view.state.field(embeddedObjectSelectionField, false);
    if (!objectSelection || !view.state.selection.main.empty || text.length === 0) return false;
    const insertAt = objectSelection.edge === "before" ? objectSelection.from : objectSelection.to;
    view.dispatch({
        changes: { from: insertAt, insert: text },
        selection: EditorSelection.cursor(insertAt + text.length, 1),
        effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
        userEvent: "input.type"
    });
    return true;
});

class EmbeddedBlockWidget extends WidgetType {
    root: Root | null = null;
    ownerView: EditorView | null = null;

    public stateRef: { pos: number, length: number };

    private occurrenceKey() {
        const parsed = parseEmbeddedText(this.text);
        const fullLabel = resolveEmbeddedLabel(parsed, this.parentLabel);
        const state = useStore.getState();
        const targetId = state.blockIdByLabel[fullLabel];
        const layoutSettingsFingerprint = embeddedContentFingerprint(JSON.stringify(state.settings || {}));
        return JSON.stringify([
            ...this.occurrencePath,
            `${targetId || fullLabel}@${this.from}:${this.renderPart}:${embeddedTreeFingerprint(fullLabel)}:${layoutSettingsFingerprint}`
        ]);
    }

    private isStandaloneOpen() {
        return parseEmbeddedText(this.text).open && this.isAtStartOfLine && this.isAtEndOfLine;
    }

    private retainsBlockHeight() {
        return parseEmbeddedText(this.text).open &&
            (this.renderPart === "body" || (this.renderPart === "full" && this.isStandaloneOpen()));
    }

    private retainsTitleEstimate() {
        return parseEmbeddedText(this.text).open && this.renderPart === "title" && this.isStandaloneOpen();
    }

    get estimatedHeight() {
        if (!this.retainsBlockHeight() && !this.retainsTitleEstimate()) return -1;
        return embeddedWidgetLayouts.get(this.occurrenceKey())?.height ?? -1;
    }

    private applyStandaloneLayout(dom: HTMLElement) {
        if (this.retainsBlockHeight()) {
            dom.dataset.standaloneEmbed = "true";
        } else {
            delete dom.dataset.standaloneEmbed;
        }
        delete dom.dataset.compactNestedTerminal;
        dom.style.removeProperty("margin-bottom");
    }

    private reserveRetainedHeight(dom: HTMLElement) {
        const height = this.estimatedHeight;
        if (height < 5) return;
        dom.dataset.reservedWidgetHeight = String(height);
        dom.style.height = `${height}px`;
        dom.style.minHeight = `${height}px`;
        dom.style.overflow = "hidden";
        dom.style.overflowAnchor = "none";
    }

    private observeRenderedHeight(dom: HTMLElement, view: EditorView) {
        if ((dom as any).__embeddedWidgetOwner !== this) return;
        const previous = (dom as any).__embeddedHeightObserver as ResizeObserver | undefined;
        previous?.disconnect();
        const previousLayoutFrame = (dom as any).__embeddedLayoutFrame as number | undefined;
        if (previousLayoutFrame !== undefined) cancelAnimationFrame(previousLayoutFrame);
        const previousLayoutTimer = (dom as any).__embeddedLayoutTimer as ReturnType<typeof setTimeout> | undefined;
        if (previousLayoutTimer !== undefined) clearTimeout(previousLayoutTimer);
        if (!this.retainsBlockHeight()) {
            delete dom.dataset.reservedWidgetHeight;
            dom.style.removeProperty("height");
            dom.style.removeProperty("min-height");
            dom.style.removeProperty("overflow");
            dom.style.removeProperty("overflow-anchor");
            return;
        }
        const mount = dom.querySelector<HTMLElement>(":scope > .cm-embedded-react-mount");
        if (!mount) return;
        const panel = dom.closest<HTMLElement>('[role="tabpanel"]');
        const hasTransientEditingGeometry = () => !!dom.querySelector(".cm-math-editing, .cm-embedded-editing");
        let layoutGeneration = 0;
        const beginLayoutChange = () => {
            if ((dom as any).__embeddedWidgetOwner !== this) return;
            const generation = ++layoutGeneration;
            const pendingKey = this.occurrenceKey();
            const pendingWidthBucket = Math.max(1, Math.round(mount.clientWidth / 8) * 8);
            const settledKey = dom.dataset.settledOccurrenceKey;
            const settledWidthBucket = Number(dom.dataset.settledWidthBucket || 0);
            const hasRetainedHeight = Number.parseFloat(dom.style.minHeight || "0") >= 5;
            // Release an old reservation immediately when the content tree or
            // available width genuinely changed. For the same tree and width,
            // keep the last exact height: an off-screen CodeMirror may replace
            // its DOM lines with estimated gaps, which must not shrink every
            // ancestor and move the document while the user scrolls.
            if ((settledKey && (pendingKey !== settledKey || pendingWidthBucket !== settledWidthBucket))
                || (!settledKey && !hasRetainedHeight)) {
                dom.style.removeProperty("min-height");
            }
            const previousFrame = (dom as any).__embeddedLayoutFrame as number | undefined;
            if (previousFrame !== undefined) cancelAnimationFrame(previousFrame);
            const previousTimer = (dom as any).__embeddedLayoutTimer as ReturnType<typeof setTimeout> | undefined;
            if (previousTimer !== undefined) clearTimeout(previousTimer);
            let previousHeight = -1;
            let stableFrames = 0;
            const sample = () => {
                if (generation !== layoutGeneration || (dom as any).__embeddedWidgetOwner !== this || !dom.isConnected || !mount.isConnected) return;
                if (((panel && isEmbeddedPanelScrolling(panel)) && !canSettleExplicitReopen(dom)) ||
                    hasTransientEditingGeometry()) {
                    // A just-reopened tree can become completely measured on
                    // the next frame. A 100 ms poll adds an avoidable visible
                    // reservation after its renderer is already ready.
                    if (hasActiveExplicitReopen(dom)) {
                        (dom as any).__embeddedLayoutFrame = requestAnimationFrame(sample);
                    } else {
                        (dom as any).__embeddedLayoutTimer = setTimeout(sample, 100);
                    }
                    return;
                }
                const naturalHeight = mount.getBoundingClientRect().height;
                if (naturalHeight < 5) {
                    (dom as any).__embeddedLayoutFrame = requestAnimationFrame(sample);
                    return;
                }
                if (Math.abs(naturalHeight - previousHeight) <= 0.5) stableFrames += 1;
                else {
                    previousHeight = naturalHeight;
                    stableFrames = 0;
                }
                if (stableFrames < 2) {
                    (dom as any).__embeddedLayoutFrame = requestAnimationFrame(sample);
                    return;
                }
                const key = this.occurrenceKey();
                const widthBucket = Math.max(1, Math.round(mount.clientWidth / 8) * 8);
                const cachedLayout = embeddedWidgetLayouts.get(key);
                const cachedHeight = cachedLayout?.height;
                const cachedWidthBucket = cachedLayout?.widthBucket;
                // Keep the larger value only for the exact same content tree
                // and width. That prevents an off-screen CodeMirror estimate
                // from shrinking a stable widget, including idle remounts. A real
                // descendant toggle changes the tree key and may shrink; the
                // destroy path below also caches the live mount rather than a
                // stale outer min-height, so the new key cannot be poisoned.
                const measuredHeight = Math.ceil(naturalHeight);
                const sameLayoutCache = cachedHeight !== undefined && cachedWidthBucket === widthBucket;
                const staleLargeReservation = sameLayoutCache && cachedHeight > measuredHeight + 8 &&
                    canRefineEmbeddedHeight(panel, dom);
                const settledHeight = sameLayoutCache && !staleLargeReservation
                    ? Math.max(cachedHeight, measuredHeight)
                    : measuredHeight;
                dom.dataset.widgetOccurrenceKey = key;
                dom.dataset.settledOccurrenceKey = key;
                dom.dataset.settledWidthBucket = String(widthBucket);
                replaceEmbeddedWidgetHeight(key, settledHeight, widthBucket);
                commitEmbeddedHeight(panel, dom, settledHeight);
                view.requestMeasure();
            };
            (dom as any).__embeddedLayoutFrame = requestAnimationFrame(sample);
        };
        (dom as any).__beginEmbeddedLayoutChange = beginLayoutChange;
        delete dom.dataset.reservedWidgetHeight;
        dom.style.removeProperty("height");
        dom.style.removeProperty("overflow");
        dom.style.removeProperty("overflow-anchor");
        // Publish the first real geometry immediately. Waiting for several
        // observer frames leaves a short interval in which CodeMirror can
        // virtualize this block with an unknown height; remounting then shifts
        // the viewport by the entire embedded body. The observer below still
        // refines this value after math, images, and nested editors settle.
        const initialHeight = mount.getBoundingClientRect().height;
        if (initialHeight >= 5) {
            const key = this.occurrenceKey();
            const widthBucket = Math.max(1, Math.round(mount.clientWidth / 8) * 8);
            const cachedLayout = embeddedWidgetLayouts.get(key);
            const measuredHeight = cachedLayout?.height !== undefined && cachedLayout.widthBucket === widthBucket &&
                ((panel && isEmbeddedPanelScrolling(panel)) || !canRefineEmbeddedHeight(panel, dom))
                ? Math.max(cachedLayout.height, Math.ceil(initialHeight))
                : Math.ceil(initialHeight);
            dom.dataset.widgetOccurrenceKey = key;
            dom.dataset.settledOccurrenceKey = key;
            dom.dataset.settledWidthBucket = String(widthBucket);
            replaceEmbeddedWidgetHeight(key, measuredHeight, widthBucket);
            commitEmbeddedHeight(panel, dom, measuredHeight);
        }
        view.requestMeasure();
        requestAnimationFrame(() => {
            if ((dom as any).__embeddedWidgetOwner !== this || !dom.isConnected) return;
            beginLayoutChange();
            if (typeof ResizeObserver === "undefined") return;
            const observer = new ResizeObserver(beginLayoutChange);
            observer.observe(mount);
            (dom as any).__embeddedHeightObserver = observer;
        });
    }

    private finishRenderedDOM(dom: HTMLElement, view: EditorView) {
        if ((dom as any).__embeddedWidgetOwner !== this || !dom.isConnected) return;
        const mount = dom.querySelector<HTMLElement>(":scope > .cm-embedded-react-mount");
        const snapshot = dom.querySelector<HTMLElement>(":scope > .cm-embedded-snapshot");
        if (snapshot && mount) {
            snapshot.remove();
            mount.style.removeProperty("visibility");
            mount.style.removeProperty("position");
            mount.style.removeProperty("inset");
            mount.style.removeProperty("width");
            mount.removeAttribute("aria-hidden");
        }
        if (this.retainsTitleEstimate() && mount) {
            const height = mount.getBoundingClientRect().height;
            if (height >= 5) {
                const key = this.occurrenceKey();
                const widthBucket = Math.max(1, Math.round(mount.clientWidth / 8) * 8);
                replaceEmbeddedWidgetHeight(key, Math.ceil(height), widthBucket);
                dom.dataset.widgetOccurrenceKey = key;
                view.requestMeasure();
            }
            return;
        }
        this.observeRenderedHeight(dom, view);
    }

    constructor(
        public text: string, 
        public parentLabel: string, 
        public visitedLabels: string[],
        public occurrencePath: string[],
        public from: number, 
        public to: number,
        public isAtEndOfLine: boolean = false,
        public isAtStartOfLine: boolean = false,
        public isKeyboardSelected: boolean = false,
        public keyboardSelectionEdge?: "before" | "after",
        public renderPart: "full" | "title" | "body" = "full",
        public occurrenceId: number = 0,
        existingStateRef?: { pos: number, length: number }
    ) {
        super();
        this.stateRef = existingStateRef || { pos: from, length: to - from };
        this.stateRef.pos = from;
        this.stateRef.length = to - from;
    }

    eq(other: EmbeddedBlockWidget) {
        return this.text === other.text && 
               this.parentLabel === other.parentLabel && 
               JSON.stringify(this.visitedLabels) === JSON.stringify(other.visitedLabels) &&
               JSON.stringify(this.occurrencePath) === JSON.stringify(other.occurrencePath) &&
               this.from === other.from &&
               this.to === other.to &&
               this.isAtEndOfLine === other.isAtEndOfLine &&
               this.isAtStartOfLine === other.isAtStartOfLine &&
               this.isKeyboardSelected === other.isKeyboardSelected &&
               this.keyboardSelectionEdge === other.keyboardSelectionEdge &&
               this.renderPart === other.renderPart &&
               this.occurrenceId === other.occurrenceId;
    }

    toDOM(view: EditorView) {
        // A standalone title and every expanded body participate in block
        // layout. Keeping the title in a span while React renders a block
        // element inside it gives the browser an anonymous line box whose
        // geometry CodeMirror can mistake for the cursor row.
        const dom = document.createElement(this.renderPart === "body" ? "div" : "span");
        dom.className = "cm-embedded-block-wrapper text-left";
        dom.dataset.embedFrom = String(this.from);
        dom.dataset.embedTo = String(this.to);
        dom.dataset.embedPart = this.renderPart;
        dom.dataset.widgetOccurrenceKey = this.occurrenceKey();
        (dom as any).__embeddedWidgetOwner = this;
        this.ownerView = view;
        this.applyStandaloneLayout(dom);
        if (this.retainsBlockHeight()) {
            const expiresAt = explicitReopenExpiry(view, this.from);
            if (expiresAt) dom.dataset.explicitReopenUntil = String(expiresAt);
        }
        registerEmbedWrapper(view, dom);
        this.reserveRetainedHeight(dom);

        const mount = document.createElement("span");
        mount.className = "cm-embedded-react-mount";
        const snapshotHtml = this.retainsBlockHeight()
            ? embeddedWidgetLayouts.get(this.occurrenceKey())?.snapshotHtml
            : undefined;
        if (snapshotHtml) {
            const snapshot = document.createElement("span");
            snapshot.className = "cm-embedded-snapshot";
            snapshot.setAttribute("aria-hidden", "true");
            snapshot.setAttribute("inert", "");
            snapshot.innerHTML = snapshotHtml;
            dom.appendChild(snapshot);
            mount.style.visibility = "hidden";
            mount.style.position = "absolute";
            mount.style.inset = "0";
            mount.style.width = "100%";
            mount.setAttribute("aria-hidden", "true");
        }
        dom.appendChild(mount);

        this.root = createRoot(mount);
        (dom as any).__root = this.root;
        this.root.render(
            <EmbeddedBlockUI 
                text={this.text}
                parentLabel={this.parentLabel}
                visitedLabels={this.visitedLabels}
                occurrencePath={this.occurrencePath}
                view={view}
                stateRef={this.stateRef}
                isAtEndOfLine={this.isAtEndOfLine}
                isAtStartOfLine={this.isAtStartOfLine}
                isKeyboardSelected={this.isKeyboardSelected}
                keyboardSelectionEdge={this.keyboardSelectionEdge}
                renderPart={this.renderPart}
                onRendererReady={() => this.finishRenderedDOM(dom, view)}
                toggleOpen={(e?: React.MouseEvent) => {
                    const coords = view.coordsAtPos(this.from);
                    const initialY = coords ? coords.top : 0;

                    const doc = view.state.doc.toString();
                    const slice = doc.slice(this.from, this.to);
                    if (slice.startsWith("[[") && slice.endsWith("]]")) {
                        const inner = slice.slice(2, -2);
                        const isClosing = parseEmbeddedLinks(slice)[0]?.open ?? false;
                        const toggledText = `[[${setEmbeddedOpen(inner, !isClosing)}]]`;
                        if (!isClosing) markExplicitReopen(view, this.from);
                        
                        if (isClosing && !e) {
                            view.dispatch({
                                changes: { from: this.from, to: this.to, insert: toggledText },
                                selection: { anchor: this.from + toggledText.length },
                                userEvent: "input"
                            });
                            view.focus();
                        } else {
                            view.dispatch({
                                changes: { from: this.from, to: this.to, insert: toggledText },
                                userEvent: "input"
                            });
                        }

                        preserveEmbeddedTogglePosition(view, this.from, initialY);
                    }
                }}
            />
        );
        requestAnimationFrame(() => {
            this.finishRenderedDOM(dom, view);
        });
        return dom;
    }

    updateDOM(dom: HTMLElement, view: EditorView, previousWidget: WidgetType) {
        // CodeMirror searches a cache of same-class widgets, not just the
        // widget previously occupying this source range. Reusing a body div
        // for an inline title span (or a different occurrence's React root)
        // changes line layout and can also transfer child editor state.
        if (!(previousWidget instanceof EmbeddedBlockWidget) ||
            previousWidget.occurrenceId !== this.occurrenceId ||
            previousWidget.renderPart !== this.renderPart ||
            previousWidget.isAtStartOfLine !== this.isAtStartOfLine ||
            previousWidget.isAtEndOfLine !== this.isAtEndOfLine ||
            dom.tagName !== (this.renderPart === "body" ? "DIV" : "SPAN") ||
            dom.dataset.embedPart !== this.renderPart) return false;
        const root = (dom as any).__root as Root | undefined;
        if (!root) return false;

        ((dom as any).__embeddedHeightObserver as ResizeObserver | undefined)?.disconnect();
        const layoutFrame = (dom as any).__embeddedLayoutFrame as number | undefined;
        if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
        const layoutTimer = (dom as any).__embeddedLayoutTimer as ReturnType<typeof setTimeout> | undefined;
        if (layoutTimer !== undefined) clearTimeout(layoutTimer);
        delete (dom as any).__beginEmbeddedLayoutChange;
        (dom as any).__embeddedWidgetOwner = this;
        if (this.ownerView !== view) unregisterEmbedWrapper(this.ownerView, dom);
        this.ownerView = view;
        registerEmbedWrapper(view, dom);
        dom.dataset.embedFrom = String(this.from);
        dom.dataset.embedTo = String(this.to);
        dom.dataset.embedPart = this.renderPart;
        dom.dataset.widgetOccurrenceKey = this.occurrenceKey();
        this.applyStandaloneLayout(dom);
        if (root) {
            root.render(
                <EmbeddedBlockUI 
                    text={this.text}
                    parentLabel={this.parentLabel}
                    visitedLabels={this.visitedLabels}
                    occurrencePath={this.occurrencePath}
                    view={view}
                    stateRef={this.stateRef}
                    isAtEndOfLine={this.isAtEndOfLine}
                    isAtStartOfLine={this.isAtStartOfLine}
                    isKeyboardSelected={this.isKeyboardSelected}
                    keyboardSelectionEdge={this.keyboardSelectionEdge}
                    renderPart={this.renderPart}
                    onRendererReady={() => this.finishRenderedDOM(dom, view)}
                    toggleOpen={(e?: React.MouseEvent) => {
                        const coords = view.coordsAtPos(this.from);
                        const initialY = coords ? coords.top : 0;

                        const doc = view.state.doc.toString();
                        const slice = doc.slice(this.from, this.to);
                        if (slice.startsWith("[[") && slice.endsWith("]]")) {
                            const inner = slice.slice(2, -2);
                            const isClosing = parseEmbeddedLinks(slice)[0]?.open ?? false;
                            const newText = `[[${setEmbeddedOpen(inner, !isClosing)}]]`;
                            if (!isClosing) markExplicitReopen(view, this.from);
                            
                            if (isClosing && !e) {
                                view.dispatch({
                                    changes: { from: this.from, to: this.to, insert: newText },
                                    selection: { anchor: this.from + newText.length },
                                    userEvent: "input"
                                });
                                view.focus();
                            } else {
                                view.dispatch({
                                    changes: { from: this.from, to: this.to, insert: newText },
                                    userEvent: "input"
                                });
                            }

                            preserveEmbeddedTogglePosition(view, this.from, initialY);
                        }
                    }}
                />
            );
            requestAnimationFrame(() => {
                this.finishRenderedDOM(dom, view);
            });
            return true;
        }
        return false;
    }

    destroy(dom: HTMLElement) {
        if ((dom as any).__embeddedWidgetOwner === this) {
            delete (dom as any).__embeddedWidgetOwner;
        }
        if (this.retainsTitleEstimate()) {
            const mount = dom.querySelector<HTMLElement>(":scope > .cm-embedded-react-mount");
            if (mount) {
                const height = mount.getBoundingClientRect().height;
                if (height >= 5) {
                    const key = dom.dataset.widgetOccurrenceKey || this.occurrenceKey();
                    const widthBucket = Math.max(1, Math.round(mount.clientWidth / 8) * 8);
                    replaceEmbeddedWidgetHeight(key, Math.ceil(height), widthBucket);
                }
            }
        }
        if (this.retainsBlockHeight()) {
            const mount = dom.querySelector<HTMLElement>(":scope > .cm-embedded-react-mount");
            if (mount && mount.style.visibility !== "hidden") {
                // Capture the exact outer height synchronously while every
                // descendant still exists. ResizeObserver delivery can lag
                // behind a scroll-driven viewport removal, especially in a
                // deep nested tree. Without this final measurement the next
                // mount may reserve an older, smaller line-gap estimate and
                // shift every following block when its snapshot is removed.
                // Preserve the wrapper's small natural margin contribution,
                // which CodeMirror needs for pixel-stable remounting. When an
                // old min-height is instead holding open a large blank region,
                // use the live mount so that reservation cannot poison the new
                // (collapsed) tree key.
                const outerHeight = dom.getBoundingClientRect().height;
                const liveHeight = mount.getBoundingClientRect().height;
                const currentHeight = outerHeight - liveHeight > 32
                    ? liveHeight
                    : outerHeight;
                const widthBucket = Math.max(1, Math.round(mount.clientWidth / 8) * 8);
                // The store may already describe a newly collapsed tree while
                // this off-screen DOM still contains the previous expanded
                // render. Cache the measurement under the key that produced
                // this DOM, never under the newer tree's key.
                const key = dom.dataset.widgetOccurrenceKey || this.occurrenceKey();
                const cachedLayout = embeddedWidgetLayouts.get(key);
                const panel = dom.closest<HTMLElement>('[role="tabpanel"]');
                // An off-screen CodeMirror replaces real lines with estimated
                // gaps while the panel moves. Its live mount can therefore be
                // temporarily hundreds of pixels shorter. Do not let the
                // destroy/remount path publish that estimate mid-gesture or
                // while still off-screen. Once visible and idle, the observer
                // can refine it while the panel's visual anchor holds.
                const heightToCache = ((panel && isEmbeddedPanelScrolling(panel)) || !canRefineEmbeddedHeight(panel, dom))
                    && cachedLayout?.height !== undefined
                    && cachedLayout.widthBucket === widthBucket
                    ? Math.max(cachedLayout.height, currentHeight)
                    : currentHeight;
                replaceEmbeddedWidgetHeight(key, heightToCache, widthBucket);
                const snapshotHtml = captureEmbeddedWidgetSnapshot(mount);
                if (snapshotHtml) rememberEmbeddedWidgetSnapshot(key, snapshotHtml);
                else forgetEmbeddedWidgetSnapshot(key);
            }
        }
        unregisterEmbedWrapper(this.ownerView, dom);
        this.ownerView = null;
        ((dom as any).__embeddedHeightObserver as ResizeObserver | undefined)?.disconnect();
        const layoutFrame = (dom as any).__embeddedLayoutFrame as number | undefined;
        if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
        const layoutTimer = (dom as any).__embeddedLayoutTimer as ReturnType<typeof setTimeout> | undefined;
        if (layoutTimer !== undefined) clearTimeout(layoutTimer);
        delete (dom as any).__beginEmbeddedLayoutChange;
        const root = (dom as any).__root as Root;
        if (root) {
            setTimeout(() => root.unmount(), 0);
        }
    }

    ignoreEvent(e: Event) {
        if (e.target instanceof HTMLElement) {
            if (e.target.closest(".cm-embedded-block-wrapper")) {
                return true;
            }
        }
        return false;
    }
}

function buildEmbeddedDecorations(state: import("@codemirror/state").EditorState) {
    const builder = new RangeSetBuilder<Decoration>();
    const isFocused = state.field(editorFocusField, false);
    const links = state.field(parsedLinksField);
    const parentLabel = state.facet(parentLabelFacet);
    const visitedLabels = state.facet(visitedLabelsFacet);
    const occurrencePath = state.facet(occurrencePathFacet);
    const selection = state.selection.main;
    const objectSelection = state.field(embeddedObjectSelectionField, false);
    
    const decos: {from: number, to: number, deco: Decoration}[] = [];

    for (const link of links) {
        const showRawSource = isRawEmbeddedSourceVisible(state, link);
        const isKeyboardSelected = isFocused && selection.empty &&
            objectSelection?.from === link.from && objectSelection.to === link.to;

        if (showRawSource) {
            decos.push({
                from: link.from,
                to: link.to,
                deco: Decoration.mark({ class: "cm-embedded-editing bg-accent/20 rounded px-1 text-accent", inclusive: true })
            });
        } else {
            const line = state.doc.lineAt(link.to);
            const textAfter = line.text.slice(link.to - line.from);
            const isAtEndOfLine = textAfter.trim() === "";
            const textBefore = line.text.slice(0, link.from - line.from);
            const isAtStartOfLine = textBefore.trim() === "";

            const makeWidget = (renderPart: "full" | "title" | "body") => new EmbeddedBlockWidget(
                link.text,
                parentLabel,
                visitedLabels,
                occurrencePath,
                link.from,
                link.to,
                isAtEndOfLine,
                isAtStartOfLine,
                isKeyboardSelected,
                isKeyboardSelected ? objectSelection?.edge : undefined,
                renderPart,
                link.occurrenceId
            );

            decos.push({
                from: link.from,
                to: link.to,
                deco: Decoration.replace({
                    widget: makeWidget(link.open ? "title" : "full"),
                    // Only the title replaces the Markdown token. The expanded
                    // body is a separate block decoration below the containing
                    // source line, so the real positions at link.from/link.to
                    // retain title-sized cursor geometry.
                    block: false
                })
            });
            if (link.open) {
                const bodyPosition = link.to;
                decos.push({
                    // Keep the expansion at the embedded token boundary. A
                    // block widget at link.to splits the visual line there, so
                    // source text after [[label]] becomes a continuation below
                    // the embedded body: prefix -> title -> body -> suffix.
                    // The title remains a separate inline replacement so its
                    // source edges retain normal caret geometry.
                    from: bodyPosition,
                    to: bodyPosition,
                    deco: Decoration.widget({
                        widget: makeWidget("body"),
                        block: true,
                        // inlineOrder allows a block widget to live between two
                        // inline fragments of the same Markdown source line.
                        inlineOrder: true,
                        // Keep the widget on the leading side of link.to. A
                        // cursor associated forward with that source boundary
                        // then belongs to the suffix after the body, instead of
                        // being drawn beside the replacement title. When there
                        // is no suffix, place the block on the trailing side of
                        // the completed source line instead. That avoids asking
                        // CodeMirror to create an otherwise empty continuation
                        // row below the embedded body.
                        side: isAtEndOfLine ? 1 : -1
                    })
                });
            }
        }
    }

    // RangeSetBuilder requires ties to follow the decoration side ordering.
    // This matters when an expansion is placed immediately before another
    // line-wide replacement: the body widget must sort before that range or it
    // is swallowed by the following replacement.
    decos.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || b.to - a.to);

    for (const d of decos) {
        builder.add(d.from, d.to, d.deco);
    }
    return builder.finish();
}

export const embeddedBlockPlugin = StateField.define<DecorationSet>({
    create(state) {
        return buildEmbeddedDecorations(state);
    },
    update(decorations, tr) {
        if (tr.docChanged || tr.selection || tr.effects.some(e => e.is(setEditorFocus) || e.is(setEmbeddedObjectSelection))) {
            return buildEmbeddedDecorations(tr.state);
        }
        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

function getEmbedTooltip(state: import("@codemirror/state").EditorState): Tooltip | null {
    const isFocused = state.field(editorFocusField, false);
    if (!isFocused) return null;

    const links = state.field(parsedLinksField);
    const selection = state.selection.main;
    const parentLabel = state.facet(parentLabelFacet);

    for (const link of links) {
        if (selection.head >= link.from + 2 && selection.head <= link.to - 2) {
            const fullLabel = resolveEmbeddedLabel(link, parentLabel);

            const store = useStore.getState();
            const isLabelExisted = !!store.blockIdByLabel[fullLabel];

            if (isLabelExisted) {
                return {
                    pos: link.from,
                    above: true,
                    create() {
                        const dom = document.createElement("div");
                        dom.className = "flex items-center gap-2 p-2 bg-surface text-[15px] border border-outline shadow-lg rounded-xl text-primary z-50 mb-3 mx-2 pointer-events-none px-3";
                        
                        const textObj = document.createElement("span");
                        textObj.className = "text-sm text-secondary font-medium";
                        textObj.innerHTML = `<kbd class="px-[5px] py-[2px] bg-neutral-800 rounded mx-1 text-xs text-primary border border-neutral-700 shadow-sm font-sans mx-1">Enter</kbd> to toggle · <kbd class="px-[5px] py-[2px] bg-neutral-800 rounded mx-1 text-xs text-primary border border-neutral-700 shadow-sm font-sans mx-1">Cmd/Ctrl + Enter</kbd> for new tab`;
                        
                        dom.appendChild(textObj);

                        return { dom };
                    }
                };
            }
        }
    }
    return null;
}

export const embedTooltipField = showTooltip.compute(
    ["doc", "selection", editorFocusField, parsedLinksField],
    (state) => getEmbedTooltip(state)
);

type VisualEmbedPortal = {
    kind: "title" | "body";
    link: ParsedLink;
    element: HTMLElement;
    distance: number;
};

function directEmbedElement(wrapper: HTMLElement, selector: string): HTMLElement | null {
    for (const element of Array.from(wrapper.querySelectorAll<HTMLElement>(selector))) {
        if (element.closest(".cm-embedded-block-wrapper") === wrapper) return element;
    }
    return null;
}

function portalCoordinate(rect: DOMRect, kind: VisualEmbedPortal["kind"], direction: "up" | "down", lineHeight: number) {
    if (kind === "title") return (rect.top + rect.bottom) / 2;
    const inset = Math.min(lineHeight / 2, rect.height / 2);
    return direction === "down" ? rect.top + inset : rect.bottom - inset;
}

function revealRenderedTitleIfNeeded(title: HTMLElement) {
    requestAnimationFrame(() => {
        if (!title.isConnected) return;
        const panel = title.closest<HTMLElement>('[role="tabpanel"]');
        const titleRect = title.getBoundingClientRect();
        const viewport = panel?.getBoundingClientRect();
        const top = (viewport?.top ?? 0) + 8;
        const bottom = (viewport?.bottom ?? window.innerHeight) - 8;
        const delta = titleRect.top < top
            ? titleRect.top - top
            : titleRect.bottom > bottom ? titleRect.bottom - bottom : 0;
        if (delta && panel) setEmbeddedPanelScrollTop(panel, panel.scrollTop + delta);
        else if (delta) title.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
}

function hasVisibleInlineSuffix(view: EditorView, link: ParsedLink) {
    if (!link.open) return false;
    const line = view.state.doc.lineAt(link.to);
    return view.state.doc.sliceString(link.to, line.to).trim().length > 0;
}

function openInlineLinkAtSuffixStart(view: EditorView) {
    const selection = view.state.selection.main;
    if (!selection.empty) return undefined;
    return view.state.field(parsedLinksField).find(link =>
        link.to === selection.head && hasVisibleInlineSuffix(view, link)
    );
}

function selectOpenTitleEnd(view: EditorView, link: ParsedLink) {
    view.dispatch({
        selection: EditorSelection.cursor(link.to, -1),
        effects: [
            setEditorFocus.of(true),
            setEmbeddedObjectSelection.of({ from: link.from, to: link.to, edge: "after" })
        ]
    });
    const title = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-embedded-block-wrapper"))
        .filter(element => element.closest(".cm-editor") === view.dom &&
            Number(element.dataset.embedFrom) === link.from && Number(element.dataset.embedTo) === link.to)
        .map(element => directEmbedElement(element, "[data-embed-nav-title]"))
        .find((element): element is HTMLElement => Boolean(element));
    if (title) revealRenderedTitleIfNeeded(title);
}

function selectInlineSuffixStart(view: EditorView, link: ParsedLink) {
    const nextTitle = view.state.field(parsedLinksField).find(candidate => candidate.from === link.to);
    view.dispatch({
        selection: EditorSelection.cursor(link.to, 1),
        effects: [
            setEditorFocus.of(true),
            setEmbeddedObjectSelection.of(nextTitle
                ? { from: nextTitle.from, to: nextTitle.to, edge: "before" }
                : null)
        ]
    });
    requestAnimationFrame(() => {
        if (!view.dom.isConnected || view.state.selection.main.head !== link.to ||
            view.state.field(embeddedObjectSelectionField, false)) return;
        const caret = view.coordsAtPos(link.to, 1);
        const panel = view.dom.closest<HTMLElement>('[role="tabpanel"]');
        const viewport = panel?.getBoundingClientRect();
        if (!caret || !panel || !viewport) return;
        const top = viewport.top + 8;
        const bottom = viewport.bottom - 8;
        const delta = caret.top < top ? caret.top - top : caret.bottom > bottom ? caret.bottom - bottom : 0;
        if (delta) setEmbeddedPanelScrollTop(panel, panel.scrollTop + delta);
    });
}

function movePastClosedStandoutTitle(
    view: EditorView,
    link: ParsedLink,
    title: HTMLElement,
    direction: "up" | "down",
    x: number
) {
    const forward = direction === "down";
    const line = view.state.doc.lineAt(forward ? link.to : link.from);
    const sameLineLinks = view.state.field(parsedLinksField)
        .filter(candidate => view.state.doc.lineAt(candidate.from).number === line.number)
        .sort((a, b) => a.from - b.from);
    const linkIndex = sameLineLinks.findIndex(candidate => candidate.from === link.from && candidate.to === link.to);
    const textFrom = forward ? link.to : (linkIndex > 0 ? sameLineLinks[linkIndex - 1].to : line.from);
    const textTo = forward
        ? (linkIndex >= 0 && linkIndex < sameLineLinks.length - 1 ? sameLineLinks[linkIndex + 1].from : line.to)
        : link.from;
    const adjacentText = view.state.doc.sliceString(textFrom, textTo);

    if (adjacentText.trim().length > 0) {
        const boundary = forward ? link.to : link.from;
        const boundaryCoords = view.coordsAtPos(boundary, forward ? 1 : -1);
        let anchor = boundary;
        if (boundaryCoords) {
            const estimated = view.posAtCoords({
                x,
                y: (boundaryCoords.top + boundaryCoords.bottom) / 2
            }, false);
            anchor = Math.max(textFrom, Math.min(textTo, estimated));
        }
        const destination = EditorSelection.cursor(anchor, forward ? 1 : -1);
        view.dispatch({
            selection: EditorSelection.create([destination]),
            effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
            scrollIntoView: false
        });
        return true;
    }

    const edge = forward ? link.to : link.from;
    const start = EditorSelection.cursor(edge, forward ? 1 : -1);
    const moved = view.moveVertically(start, forward);
    let anchor = moved.head;

    if (anchor >= link.from && anchor <= link.to) {
        const rect = title.getBoundingClientRect();
        const y = forward
            ? rect.bottom + view.defaultLineHeight / 2
            : rect.top - view.defaultLineHeight / 2;
        anchor = view.posAtCoords({ x, y }, false);
    }

    // A standalone standout can map the probe back onto its atomic boundary.
    // In that case advance to the adjacent source row rather than skipping an
    // additional rendered row or leaving the selection stuck on the title.
    if (anchor >= link.from && anchor <= link.to) {
        const line = view.state.doc.lineAt(forward ? link.to : link.from);
        if (forward && line.number < view.state.doc.lines) {
            anchor = view.state.doc.line(line.number + 1).from;
        } else if (!forward && line.number > 1) {
            anchor = view.state.doc.line(line.number - 1).to;
        } else {
            anchor = edge;
        }
    }

    if (anchor === view.state.selection.main.head) return false;
    const destination = EditorSelection.cursor(anchor, forward ? 1 : -1);
    view.dispatch({
        selection: EditorSelection.create([destination]),
        effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
        scrollIntoView: false
    });
    return true;
}

type AdjacentVisualTextPosition = {
    anchor: number;
    assoc: -1 | 1;
    distance: number;
};

function findAdjacentVisualTextPosition(
    view: EditorView,
    selection: import("@codemirror/state").SelectionRange,
    direction: "up" | "down",
    x: number,
    currentTop: number,
    currentBottom: number
): AdjacentVisualTextPosition | null {
    const forward = direction === "down";
    const links = view.state.field(parsedLinksField);
    const maximumProbeDistance = Math.max(120, view.defaultLineHeight * 5);
    const contentLeft = view.contentDOM.getBoundingClientRect().left + 1;
    const seen = new Set<string>();
    let nearest: AdjacentVisualTextPosition | null = null;

    // Probe the rendered surface rather than trusting source-line geometry.
    // The probe point must intersect the returned caret row; this rejects the
    // gap fallback that otherwise maps to an earlier wrap or a distant widget.
    for (let offset = 2; offset <= maximumProbeDistance; offset += 2) {
        const y = forward ? currentBottom + offset : currentTop - offset;
        // First preserve the desired x. Also probe the row's leading edge: when
        // x lies beyond a short/empty row, CodeMirror may map it to a wider
        // decoration farther away. The leading-edge probe proves that the near
        // row exists without changing the eventual goalColumn.
        for (const probeX of x === contentLeft ? [x] : [x, contentLeft]) {
            const anchor = view.posAtCoords({ x: probeX, y }, false);
            if (anchor === null) continue;
            if (links.some(link => anchor >= link.from && anchor <= link.to)) continue;

            for (const assoc of [-1, 1] as const) {
                const key = `${anchor}:${assoc}`;
                if (seen.has(key) || (anchor === selection.head && assoc === selection.assoc)) continue;
                seen.add(key);
                const coords = view.coordsAtPos(anchor, assoc);
                if (!coords) continue;
                // posAtCoords can map blank space between wrapped rows back to a
                // nearby document position. Only accept a caret whose rendered
                // row actually intersects the point being probed.
                if (coords.bottom < y - 1 || coords.top > y + 1) continue;
                const distance = forward ? coords.top - currentTop : currentBottom - coords.bottom;
                if (distance <= 2) continue;
                if (!nearest || distance < nearest.distance) nearest = { anchor, assoc, distance };
            }
        }
    }
    return nearest;
}

/**
 * A standalone rendered title still belongs to one precise Markdown line.
 * Resolve the row immediately above from that source structure before using
 * screen-distance probes. This preserves real empty rows, and when the
 * preceding source row ends in an open embed it forwards an end-focus request
 * into that child. CodeMirrorEditor repeats enterOpenEmbeddedAtEnd for every
 * final open descendant, so crossing nested bottom boundaries has no pixel or
 * depth limit.
 */
function moveUpFromStandaloneTitleLogically(
    view: EditorView,
    link: ParsedLink,
    x: number
) {
    const doc = view.state.doc;
    const line = doc.lineAt(link.from);
    const prefix = doc.sliceString(line.from, link.from);
    const suffix = doc.sliceString(link.to, line.to);
    if (prefix.trim().length > 0 || suffix.trim().length > 0 || line.number <= 1) return false;

    const previousLine = doc.line(line.number - 1);
    const links = view.state.field(parsedLinksField);
    const previousLineLinks = links.filter(candidate =>
        candidate.from >= previousLine.from && candidate.to <= previousLine.to
    );
    const previousOpenLink = [...links].reverse().find(candidate =>
        candidate.open &&
        candidate.from >= previousLine.from &&
        candidate.to <= previousLine.to &&
        doc.sliceString(candidate.to, previousLine.to).trim().length === 0
    );

    if (previousOpenLink) {
        const parentLabel = view.state.facet(parentLabelFacet);
        const fullLabel = resolveEmbeddedLabel(previousOpenLink, parentLabel);
        const visited = view.state.facet(visitedLabelsFacet);
        if (visited.includes(fullLabel)) return false;
        const store = useStore.getState();
        const targetBlockId = store.blockIdByLabel[fullLabel];
        if (!targetBlockId) return false;
        const occurrenceKey = promoteTargetOccurrence(view, targetBlockId, previousOpenLink.from);
        store.setActiveBlock(
            targetBlockId,
            "end",
            [...visited, fullLabel],
            previousOpenLink.from,
            x,
            occurrenceKey
        );
        view.contentDOM.blur();
        return true;
    }

    // Let the visual portal resolver select a closed/inline title on the
    // preceding row. Dispatching a plain cursor into its hidden source range
    // would expose [[...]] instead of selecting the rendered object.
    if (previousLineLinks.length > 0) return false;

    const rowCoords = view.coordsAtPos(previousLine.to, -1) ?? view.coordsAtPos(previousLine.from, 1);
    let anchor = previousLine.to;
    if (rowCoords) {
        const mapped = view.posAtCoords({
            x,
            y: (rowCoords.top + rowCoords.bottom) / 2
        }, false);
        anchor = Math.max(previousLine.from, Math.min(previousLine.to, mapped));
    }
    const goalColumn = Math.max(0, x - view.contentDOM.getBoundingClientRect().left);
    const destination = EditorSelection.cursor(anchor, -1, undefined, goalColumn);
    const origin = view.state.selection.main;
    view.dispatch({
        selection: EditorSelection.create([destination]),
        effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
        scrollIntoView: false
    });
    rememberVisualMove(view, "up", origin, destination);
    return true;
}

/**
 * A standalone rendered title belongs to one source row even when its DOM
 * replacement is much narrower than the editor. Resolve the next ordinary
 * source row before doing an x-coordinate probe, and clamp the horizontal
 * goal inside that row. This prevents a later wide block widget from attracting
 * Down past a blank or short text row.
 */
function moveDownFromStandaloneTitleLogically(
    view: EditorView,
    link: ParsedLink,
    x: number
) {
    const doc = view.state.doc;
    const line = doc.lineAt(link.from);
    const prefix = doc.sliceString(line.from, link.from);
    const suffix = doc.sliceString(link.to, line.to);
    if (prefix.trim().length > 0 || suffix.trim().length > 0 || line.number >= doc.lines) return false;

    const nextLine = doc.line(line.number + 1);
    const links = view.state.field(parsedLinksField);
    const nextLineLinks = links.filter(candidate =>
        candidate.from >= nextLine.from && candidate.to <= nextLine.to
    );
    // A rendered embed on the next row must be handled as a title/body portal,
    // never as a cursor in its hidden Markdown source.
    if (nextLineLinks.length > 0) return false;

    let anchor = nextLine.from;
    const rowCoords = view.coordsAtPos(nextLine.from, 1);
    if (nextLine.length > 0 && rowCoords) {
        const mapped = view.posAtCoords({
            x,
            y: (rowCoords.top + rowCoords.bottom) / 2
        }, false);
        anchor = Math.max(nextLine.from, Math.min(nextLine.to, mapped));
    }
    const goalColumn = Math.max(0, x - view.contentDOM.getBoundingClientRect().left);
    const destination = EditorSelection.cursor(anchor, 1, undefined, goalColumn);
    const origin = view.state.selection.main;
    view.dispatch({
        selection: EditorSelection.create([destination]),
        effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
        scrollIntoView: false
    });
    rememberVisualMove(view, "down", origin, destination);
    return true;
}

/**
 * Object selection is drawn beside the rendered title, but an open embed's
 * hidden Markdown boundary can be laid out below its expanded child body.
 * Starting Up/Down from that source coordinate skips visual rows. Resolve the
 * adjacent row from the title rectangle instead.
 */
function moveFromSelectedTitleToAdjacentRow(
    view: EditorView,
    link: ParsedLink,
    title: HTMLElement,
    direction: "up" | "down",
    x: number,
    ownedWrappers: HTMLElement[]
) {
    const forward = direction === "down";
    if (!forward && moveUpFromStandaloneTitleLogically(view, link, x)) return true;
    const titleRect = title.getBoundingClientRect();
    const doc = view.state.doc;
    const titleLine = doc.lineAt(forward ? link.to : link.from);
    const adjacentNumber = titleLine.number + (forward ? 1 : -1);
    if (adjacentNumber >= 1 && adjacentNumber <= doc.lines) {
        const sameLineText = doc.sliceString(forward ? link.to : titleLine.from,
            forward ? titleLine.to : link.from);
        const sameLineEdge = sameLineText.trim().length > 0
            ? view.coordsAtPos(forward ? titleLine.to : titleLine.from, forward ? -1 : 1)
            : null;
        const sameLineHasAnotherVisualRow = sameLineEdge && (forward
            ? sameLineEdge.top > titleRect.bottom + 2
            : sameLineEdge.bottom < titleRect.top - 2);
        const interveningLink = view.state.field(parsedLinksField).some(candidate =>
            candidate.from >= titleLine.from && candidate.to <= titleLine.to &&
            (forward ? candidate.from > link.from : candidate.to < link.to)
        );
        const adjacentLine = doc.line(adjacentNumber);
        const adjacentHasLink = view.state.field(parsedLinksField).some(candidate =>
            candidate.from >= adjacentLine.from && candidate.to <= adjacentLine.to
        );
        const adjacentIsDisplayMath = view.state.field(parsedRangesField).some(range =>
            range.type === "blockMath" && range.from <= adjacentLine.to && range.to >= adjacentLine.from
        );
        // A selected inline title has a visual caret that is not its hidden
        // Markdown endpoint. When the next source row is ordinary text, bind
        // the move to that row before probing coordinates: inline math on it
        // can otherwise map the probe into a more distant display equation.
        // Keep wrapped same-line text, other embeds, and display math on their
        // existing portal routes.
        if (!sameLineHasAnotherVisualRow && !interveningLink &&
            !adjacentHasLink && !adjacentIsDisplayMath) {
            const edge = forward ? adjacentLine.from : adjacentLine.to;
            const assoc = forward ? 1 : -1;
            const rowCoords = view.coordsAtPos(edge, assoc);
            const isAdjacentOnScreen = rowCoords && (forward
                ? rowCoords.top >= titleRect.bottom - 2
                : rowCoords.bottom <= titleRect.top + 2);
            if (isAdjacentOnScreen) {
                const mapped = view.posAtCoords({
                    x,
                    y: (rowCoords.top + rowCoords.bottom) / 2
                }, false);
                let anchor = Math.max(adjacentLine.from,
                    Math.min(adjacentLine.to, mapped ?? edge));
                const mappedCoords = view.coordsAtPos(anchor, assoc);
                if (!mappedCoords || mappedCoords.bottom < rowCoords.top - 2 ||
                    mappedCoords.top > rowCoords.bottom + 2) anchor = edge;
                const goalColumn = Math.max(0, x - view.contentDOM.getBoundingClientRect().left);
                const destination = EditorSelection.cursor(anchor, assoc, undefined, goalColumn);
                const origin = view.state.selection.main;
                view.dispatch({
                    selection: EditorSelection.create([destination]),
                    effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
                    scrollIntoView: false
                });
                rememberVisualMove(view, direction, origin, destination);
                return true;
            }
        }
    }
    let adjacent = findAdjacentVisualTextPosition(
        view,
        view.state.selection.main,
        direction,
        x,
        titleRect.top,
        titleRect.bottom
    );
    if (!adjacent || (adjacent.anchor >= link.from && adjacent.anchor <= link.to)) {
        const rows = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
            .filter(row => row.closest('.cm-editor') === view.dom)
            .map(row => ({ row, rect: row.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width > 0 && rect.height > 0 && (
                forward ? rect.top >= titleRect.bottom - 1 : rect.bottom <= titleRect.top + 1
            ))
            .sort((a, b) => forward ? a.rect.top - b.rect.top : b.rect.bottom - a.rect.bottom);
        for (const { rect } of rows) {
            const probeX = Math.max(rect.left + 1, Math.min(x, rect.right - 1));
            // A .cm-line may contain many visual wraps. Probe the edge nearest
            // the title, not the element midpoint, so this remains exactly one
            // rendered-row move.
            const probeY = forward ? rect.top + 1 : rect.bottom - 1;
            const anchor = view.posAtCoords({ x: probeX, y: probeY }, false);
            if (anchor === null || view.state.field(parsedLinksField).some(candidate =>
                anchor >= candidate.from && anchor <= candidate.to && !isRawEmbeddedSourceVisible(view.state, candidate)
            )) continue;
            const coords = view.coordsAtPos(anchor, forward ? 1 : -1);
            if (!coords) continue;
            adjacent = {
                anchor,
                assoc: forward ? 1 : -1,
                distance: forward ? coords.top - titleRect.top : titleRect.bottom - coords.bottom
            };
            break;
        }
    }
    if (!adjacent || (adjacent.anchor >= link.from && adjacent.anchor <= link.to)) return false;

    // Text probes can see a short row beyond a rendered title/body, especially
    // when the horizontal goal is wider than that intervening title. Let the
    // common portal resolver choose the first visible boundary in that case.
    // A plain cursor here would otherwise skip the embed or enter its source.
    const adjacentCoords = view.coordsAtPos(adjacent.anchor, adjacent.assoc);
    if (!adjacentCoords) return false;
    const links = view.state.field(parsedLinksField);
    const interveningPortal = ownedWrappers.some(wrapper => {
        const from = Number(wrapper.dataset.embedFrom);
        const to = Number(wrapper.dataset.embedTo);
        const candidate = links.find(item => item.from === from && item.to === to);
        if (!candidate || isRawEmbeddedSourceVisible(view.state, candidate)) return false;
        return (["title", "body"] as const).some(kind => {
            if (kind === "body" && !candidate.open) return false;
            const element = directEmbedElement(wrapper, `[data-embed-nav-${kind}]`);
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            return forward
                ? rect.top >= titleRect.bottom - 1 && rect.top < adjacentCoords.bottom - 1
                : rect.bottom <= titleRect.top + 1 && rect.bottom > adjacentCoords.top + 1;
        });
    });
    if (interveningPortal) return false;

    const goalColumn = Math.max(0, x - view.contentDOM.getBoundingClientRect().left);
    const destination = EditorSelection.cursor(adjacent.anchor, adjacent.assoc, undefined, goalColumn);
    const origin = view.state.selection.main;
    view.dispatch({
        selection: EditorSelection.create([destination]),
        effects: setEditorFocus.of(true),
        scrollIntoView: false
    });
    rememberVisualMove(view, direction, origin, destination);
    return true;
}

/**
 * Route a vertical move through the first actually rendered embed row. Source
 * line numbers are deliberately not used: wrapping, standout titles, and open
 * child editors can all add visual rows without adding Markdown lines.
 */
function runVisualEmbeddedNavigation(view: EditorView, direction: "up" | "down"): boolean {
    if (!view.hasFocus || !view.state.selection.main.empty) return false;

    const selection = view.state.selection.main;
    const links = view.state.field(parsedLinksField);
    if (links.length === 0) return false;

    const previousMove = lastVisualMoves.get(view);
    if (previousMove) {
        lastVisualMoves.delete(view);
        const isImmediateReverse = previousMove.direction !== direction &&
            previousMove.doc === view.state.doc &&
            previousMove.to.head === selection.head;
        if (isImmediateReverse) {
            const originLink = links.find(link =>
                previousMove.from.head === link.from || previousMove.from.head === link.to
            );
            const originObjectSelection = previousMove.fromObjectSelection !== undefined
                ? previousMove.fromObjectSelection
                : originLink
                ? {
                    from: originLink.from,
                    to: originLink.to,
                    edge: previousMove.from.head === originLink.from ? "before" as const : "after" as const
                }
                : null;
            let reverseDestination = previousMove.from;
            if (!originObjectSelection && previousMove.fromVisual) {
                const mappedAnchor = view.posAtCoords(previousMove.fromVisual, false);
                if (mappedAnchor !== null) {
                    const originLine = view.state.doc.lineAt(previousMove.from.head);
                    const anchor = Math.max(originLine.from, Math.min(originLine.to, mappedAnchor));
                    const candidates = ([-1, 1] as const).map(assoc => ({
                        assoc,
                        coords: view.coordsAtPos(anchor, assoc)
                    })).filter((candidate): candidate is { assoc: -1 | 1; coords: { left: number; right: number; top: number; bottom: number } } => !!candidate.coords);
                    candidates.sort((a, b) => {
                        const aY = (a.coords.top + a.coords.bottom) / 2;
                        const bY = (b.coords.top + b.coords.bottom) / 2;
                        return Math.abs(aY - previousMove.fromVisual!.y) - Math.abs(bY - previousMove.fromVisual!.y);
                    });
                    reverseDestination = EditorSelection.cursor(
                        anchor,
                        candidates[0]?.assoc ?? previousMove.from.assoc,
                        undefined,
                        previousMove.from.goalColumn
                    );
                }
            }
            view.dispatch({
                selection: EditorSelection.create([reverseDestination]),
                effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(originObjectSelection)]
            });
            return true;
        }
    }

    const objectSelection = view.state.field(embeddedObjectSelectionField, false);
    const registeredWrappers = embedWrappersByView.get(view);
    const registeredOwnedWrappers = registeredWrappers
        ? Array.from(registeredWrappers).filter(wrapper => {
            if (!wrapper.isConnected) {
                registeredWrappers.delete(wrapper);
                return false;
            }
            return wrapper.closest(".cm-editor") === view.dom;
        })
        : [];
    // CodeMirror may move a block widget into a continuation line without
    // recreating the visible DOM through WidgetType.toDOM/updateDOM. During
    // that interval the weak registration can be empty even though the portal
    // is on screen. Merge direct, editor-owned DOM wrappers so navigation can
    // never skip a visible title/body because of registry lifecycle timing.
    const domOwnedWrappers = Array.from(
        view.contentDOM.querySelectorAll<HTMLElement>(".cm-embedded-block-wrapper")
    ).filter(wrapper => wrapper.closest(".cm-editor") === view.dom);
    const ownedWrappers = Array.from(new Set([...registeredOwnedWrappers, ...domOwnedWrappers]));

    let currentTop: number | null = null;
    let currentBottom: number | null = null;
    let renderedCaretRect: DOMRect | null = null;
    let selectedLink: ParsedLink | undefined;
    let selectedTitle: HTMLElement | null = null;
    if (objectSelection) {
        selectedLink = links.find(link =>
            link.from === objectSelection.from && link.to === objectSelection.to
        );
        const selectedWrapper = ownedWrappers.find(wrapper =>
            Number(wrapper.dataset.embedFrom) === objectSelection.from &&
            Number(wrapper.dataset.embedTo) === objectSelection.to
        );
        selectedTitle = selectedWrapper
            ? directEmbedElement(selectedWrapper, "[data-embed-nav-title]")
            : null;
        if (selectedTitle) {
            const rect = selectedTitle.getBoundingClientRect();
            currentTop = rect.top;
            currentBottom = rect.bottom;
        }
    }

    const selectionSide = selection.assoc < 0 ? -1 : selection.assoc > 0 ? 1 : (direction === "down" ? 1 : -1);
    if (currentTop === null || currentBottom === null) {
        const renderedCaret = view.dom.querySelector<HTMLElement>(
            ':scope > .cm-scroller > .cm-layer .cm-cursor-primary'
        );
        if (renderedCaret) {
            const rect = renderedCaret.getBoundingClientRect();
            if (rect.height > 0) {
                renderedCaretRect = rect;
                currentTop = rect.top;
                currentBottom = rect.bottom;
            }
        }
        if (currentTop === null || currentBottom === null) {
            const caret = view.coordsAtPos(selection.head, selectionSide);
            if (!caret) return false;
            currentTop = caret.top;
            currentBottom = caret.bottom;
        }
    }

    const currentCoordinate = (currentTop + currentBottom) / 2;
    const selectedTitleRect = selectedTitle?.getBoundingClientRect();
    const currentX = selectedTitleRect && objectSelection
        ? (objectSelection.edge === "before" ? selectedTitleRect.left : selectedTitleRect.right)
        : (renderedCaretRect?.left ?? view.coordsAtPos(selection.head, selectionSide)?.left ?? view.dom.getBoundingClientRect().left);
    const goalColumn = Math.max(0, currentX - view.contentDOM.getBoundingClientRect().left);
    const lineHeight = view.defaultLineHeight;

    // A block widget at link.to splits one Markdown line into two visual
    // fragments. Clicking the very first character of the continuation can
    // still produce the same document offset as the title's after-edge. The
    // object-selection field distinguishes a selected title; without it, Up
    // from that shared offset must enter the expanded body immediately above.
    if (direction === "up" && !objectSelection) {
        const continuationLink = [...links].reverse().find(link => {
            if (!link.open) return false;
            const line = view.state.doc.lineAt(link.to);
            if (selection.head < link.to || selection.head > line.to) return false;
            const continuation = view.state.doc.sliceString(link.to, line.to);
            if (continuation.trim().length === 0) return false;
            // If CodeMirror can move to an earlier position that is still in
            // the suffix, this is a wrapped continuation row and native Up
            // must win. Otherwise the body is the previous visible region.
            const nativeUp = view.moveVertically(selection, false);
            const staysInEarlierContinuationRow = nativeUp.head < selection.head &&
                nativeUp.head > link.to && nativeUp.head <= line.to;
            return !staysInEarlierContinuationRow;
        });
        if (continuationLink) {
            const parentLabel = view.state.facet(parentLabelFacet);
            const fullLabel = resolveEmbeddedLabel(continuationLink, parentLabel);
            const store = useStore.getState();
            const targetBlockId = store.blockIdByLabel[fullLabel];
            if (targetBlockId) {
                const visited = view.state.facet(visitedLabelsFacet);
                const occurrenceKey = promoteTargetOccurrence(view, targetBlockId, continuationLink.from);
                store.setActiveBlock(
                    targetBlockId,
                    "end",
                    [...visited, fullLabel],
                    continuationLink.from,
                    currentX,
                    occurrenceKey
                );
                view.contentDOM.blur();
                return true;
            }
        }

        const currentLine = view.state.doc.lineAt(selection.head);
        const lineStartCoords = view.coordsAtPos(currentLine.from, 1);
        // Do not ask CodeMirror to move through the preceding block widget to
        // decide whether this is the first wrapped row. A block inserted at an
        // inline boundary can temporarily leave its height map with an
        // out-of-document probe position, making moveVertically throw before
        // our embedded-boundary routing runs. The source line's first caret is
        // a stable visual reference and gives the same wrapped-row answer.
        const isFirstVisualRow = !lineStartCoords || currentTop <= lineStartCoords.top + 2;
        if (isFirstVisualRow && currentLine.number > 1) {
            const previousLine = view.state.doc.line(currentLine.number - 1);
            const previousLineLinks = links.filter(link =>
                link.from >= previousLine.from && link.to <= previousLine.to
            );
            const lastPreviousLink = previousLineLinks.at(-1);
            // An inline embed can leave visible text after its title (and,
            // when open, after its body). That text still belongs to the
            // preceding source line. Native movement can map the shared
            // link.to offset to the title/body side and skip the suffix, so
            // resolve its final visible row first. This also covers a closed
            // link following an open one on the same source line.
            if (lastPreviousLink &&
                !isRawEmbeddedSourceVisible(view.state, lastPreviousLink) &&
                view.state.doc.sliceString(lastPreviousLink.to, previousLine.to).trim().length > 0) {
                const suffixEnd = view.coordsAtPos(previousLine.to, -1);
                if (suffixEnd && suffixEnd.bottom <= currentTop + 2) {
                    const rowY = (suffixEnd.top + suffixEnd.bottom) / 2;
                    const mapped = view.posAtCoords({ x: currentX, y: rowY }, false);
                    const anchor = Math.max(
                        lastPreviousLink.to,
                        Math.min(previousLine.to, mapped ?? previousLine.to)
                    );
                    const destination = EditorSelection.cursor(
                        anchor,
                        anchor === previousLine.to ? -1 : 1,
                        undefined,
                        goalColumn
                    );
                    view.dispatch({
                        selection: EditorSelection.create([destination]),
                        effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
                        scrollIntoView: false
                    });
                    rememberVisualMove(view, direction, selection, destination, {
                        x: currentX,
                        y: currentCoordinate
                    }, objectSelection);
                    return true;
                }
            }
            const previousOpenLink = [...links].reverse().find(link =>
                link.open &&
                link.from >= previousLine.from &&
                link.to <= previousLine.to &&
                view.state.doc.sliceString(link.to, previousLine.to).trim().length === 0
            );
            if (previousOpenLink) {
                const parentLabel = view.state.facet(parentLabelFacet);
                const fullLabel = resolveEmbeddedLabel(previousOpenLink, parentLabel);
                const store = useStore.getState();
                const targetBlockId = store.blockIdByLabel[fullLabel];
                if (targetBlockId) {
                    const visited = view.state.facet(visitedLabelsFacet);
                    const occurrenceKey = promoteTargetOccurrence(view, targetBlockId, previousOpenLink.from);
                    store.setActiveBlock(
                        targetBlockId,
                        "end",
                        [...visited, fullLabel],
                        previousOpenLink.from,
                        currentX,
                        occurrenceKey
                    );
                    view.contentDOM.blur();
                    return true;
                }
            }
        }
    }

    if (objectSelection) {
        if (selectedLink && selectedTitle && !selectedLink.open) {
            const movedLogically = direction === "down"
                ? moveDownFromStandaloneTitleLogically(view, selectedLink, currentX)
                : moveUpFromStandaloneTitleLogically(view, selectedLink, currentX);
            if (movedLogically) return true;
        }
        if (selectedLink?.standout && !selectedLink.open && selectedTitle) {
            return movePastClosedStandoutTitle(view, selectedLink, selectedTitle, direction, currentX);
        }
        // An open title has one unambiguous Down destination: the first row
        // of its own child editor. Avoid inferring that transition from DOM
        // rectangles, whose result can change while nested math finishes
        // measuring or another occurrence of the same block is visible.
        if (direction === "down" && selectedLink?.open) {
            const parentLabel = view.state.facet(parentLabelFacet);
            const fullLabel = resolveEmbeddedLabel(selectedLink, parentLabel);
            const store = useStore.getState();
            const targetBlockId = store.blockIdByLabel[fullLabel];
            if (targetBlockId) {
                const visited = view.state.facet(visitedLabelsFacet);
                const occurrenceKey = promoteTargetOccurrence(view, targetBlockId, selectedLink.from);
                store.setActiveBlock(
                    targetBlockId,
                    "start",
                    [...visited, fullLabel],
                    selectedLink.from,
                    currentX,
                    occurrenceKey
                );
                view.contentDOM.blur();
                return true;
            }
        }
        if (selectedLink && selectedTitle &&
            moveFromSelectedTitleToAdjacentRow(view, selectedLink, selectedTitle, direction, currentX, ownedWrappers)) {
            return true;
        }
    }

    const forward = direction === "down";
    const nativeMove = view.moveVertically(selection, forward);
    const nativeCoords = nativeMove.head === selection.head
        ? null
        : view.coordsAtPos(nativeMove.head, nativeMove.assoc || (forward ? 1 : -1));
    const nativeCoordinate = nativeCoords ? (nativeCoords.top + nativeCoords.bottom) / 2 : null;
    const candidateNativeDistance = nativeCoordinate === null
        ? Number.POSITIVE_INFINITY
        : (forward ? nativeCoordinate - currentCoordinate : currentCoordinate - nativeCoordinate);
    // CodeMirror can return a different document position that is still on
    // the same oversized replacement-widget row—or even lies in the opposite
    // visual direction. Such a position is not a successful Up/Down move and
    // must not outrank a real rendered-row portal.
    const nativeDistance = candidateNativeDistance > 2
        ? candidateNativeDistance
        : Number.POSITIVE_INFINITY;
    const probedTextMove = findAdjacentVisualTextPosition(
        view,
        selection,
        direction,
        currentX,
        currentTop,
        currentBottom
    );
    // Native movement and the coordinate probe are independent ways to find
    // the next rendered text row. Either can be confused by replacement
    // widgets, so compare the nearest validated result instead of allowing a
    // farther probe to hide a correct native wrapped-row move.
    const normalDistance = Math.min(
        nativeDistance,
        probedTextMove?.distance ?? Number.POSITIVE_INFINITY
    );

    const portals: VisualEmbedPortal[] = [];
    for (const wrapper of ownedWrappers) {
        const from = Number(wrapper.dataset.embedFrom);
        const to = Number(wrapper.dataset.embedTo);
        const link = links.find(candidate => candidate.from === from && candidate.to === to);
        if (!link || isRawEmbeddedSourceVisible(view.state, link)) continue;

        for (const kind of ["title", "body"] as const) {
            if (kind === "body" && !link.open) continue;
            const element = directEmbedElement(wrapper, `[data-embed-nav-${kind}]`);
            if (!element) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const coordinate = portalCoordinate(rect, kind, direction, lineHeight);
            const distance = forward ? coordinate - currentCoordinate : currentCoordinate - coordinate;
            if (distance > 2) portals.push({ kind, link, element, distance });
        }
    }

    portals.sort((a, b) => a.distance - b.distance || (a.kind === "title" ? -1 : 1));
    const portal = portals[0];
    const entersSelectedBody = direction === "down" && portal?.kind === "body" && !!objectSelection &&
        portal.link.from === objectSelection.from && portal.link.to === objectSelection.to;
    const nativeMoveCrossesPortal = !probedTextMove && !!portal && nativeMove.head !== selection.head && (
        forward
            ? nativeMove.head > selection.head && portal.link.from >= selection.head && portal.link.to <= nativeMove.head
            : nativeMove.head < selection.head && portal.link.from >= nativeMove.head && portal.link.to <= selection.head
    );
    const nativeMoveLandsOnPortalBoundary = !!portal &&
        (nativeMove.head === portal.link.from || nativeMove.head === portal.link.to);
    // A replacement widget can make CodeMirror's native vertical move land on
    // the widget boundary even though another soft-wrapped row from the same
    // Markdown line is visibly closer. The boundary is source-order
    // information, not proof that the portal is the next rendered row. Prefer
    // the independently validated probe only for another wrap of the current
    // logical line. Genuine blank/short source rows continue through the
    // existing source-aware path below.
    const currentSourceLine = view.state.doc.lineAt(selection.head);
    const probedSourceLine = probedTextMove
        ? view.state.doc.lineAt(probedTextMove.anchor)
        : null;
    const hasInterveningWrap = !!portal && !!probedTextMove &&
        probedSourceLine?.number === currentSourceLine.number &&
        probedTextMove.distance < portal.distance - 2;
    if (!entersSelectedBody && hasInterveningWrap) {
        const destination = EditorSelection.cursor(
            probedTextMove.anchor,
            probedTextMove.assoc,
            undefined,
            goalColumn
        );
        view.dispatch({
            selection: EditorSelection.create([destination]),
            effects: setEditorFocus.of(true),
            scrollIntoView: false
        });
        rememberVisualMove(view, direction, selection, destination, {
            x: currentX,
            y: (currentTop + currentBottom) / 2
        }, objectSelection);
        return true;
    }
    // When CodeMirror already has a destination on the same visual row, let its
    // native movement win. But never let a source-order jump skip a rendered
    // portal between the two positions. That can otherwise send Up from the
    // suffix below an open embed to an unrelated earlier inline embed.
    // When no embedded portal is actually competing with the next visual row,
    // leave ordinary wrapped-line movement to CodeMirror. Reconstructing that
    // move with posAtCoords is subtly ambiguous at wrap boundaries (the same
    // document offset can draw on either row depending on association), which
    // made an Up/Down round trip intermittently land one row away.
    if (!portal) {
        if (Number.isFinite(nativeDistance)) {
            view.dispatch({
                selection: EditorSelection.create([nativeMove]),
                effects: setEditorFocus.of(true),
                scrollIntoView: false
            });
            rememberVisualMove(view, direction, selection, nativeMove, {
                x: currentX,
                y: (currentTop + currentBottom) / 2
            }, objectSelection);
            return true;
        }
        if (!probedTextMove) return false;
        const destination = EditorSelection.cursor(
            probedTextMove.anchor,
            probedTextMove.assoc,
            undefined,
            goalColumn
        );
        view.dispatch({
            selection: EditorSelection.create([destination]),
            effects: setEditorFocus.of(true),
            scrollIntoView: false
        });
        rememberVisualMove(view, direction, selection, destination, {
            x: currentX,
            y: (currentTop + currentBottom) / 2
        }, objectSelection);
        return true;
    }

    if (!entersSelectedBody && !nativeMoveCrossesPortal && !nativeMoveLandsOnPortalBoundary &&
        portal.distance >= normalDistance - 2) {
        if (Number.isFinite(nativeDistance) &&
            (!probedTextMove || nativeDistance <= probedTextMove.distance + 2)) {
            view.dispatch({
                selection: EditorSelection.create([nativeMove]),
                effects: setEditorFocus.of(true),
                scrollIntoView: false
            });
            rememberVisualMove(view, direction, selection, nativeMove, {
                x: currentX,
                y: (currentTop + currentBottom) / 2
            }, objectSelection);
            return true;
        }
        if (!probedTextMove) return false;
        const destination = EditorSelection.cursor(
            probedTextMove.anchor,
            probedTextMove.assoc,
            undefined,
            goalColumn
        );
        view.dispatch({
            selection: EditorSelection.create([destination]),
            effects: setEditorFocus.of(true),
            scrollIntoView: false
        });
        rememberVisualMove(view, direction, selection, destination, {
            x: currentX,
            y: (currentTop + currentBottom) / 2
        }, objectSelection);
        return true;
    }

    if (portal.kind === "title") {
        const rect = portal.element.getBoundingClientRect();
        const anchor = currentX > (rect.left + rect.right) / 2 ? portal.link.to : portal.link.from;
        const destination = EditorSelection.cursor(
            anchor,
            anchor === portal.link.from ? -1 : 1,
            undefined,
            goalColumn
        );
        view.dispatch({
            selection: EditorSelection.create([destination]),
            effects: [
                setEditorFocus.of(true),
                setEmbeddedObjectSelection.of({
                    from: portal.link.from,
                    to: portal.link.to,
                    edge: anchor === portal.link.from ? "before" : "after"
                })
            ]
        });
        rememberVisualMove(view, direction, selection, destination, {
            x: currentX,
            y: (currentTop + currentBottom) / 2
        }, objectSelection);
        // The source endpoint after an open embed is geometrically below its
        // entire child body. Scrolling that hidden endpoint makes the viewport
        // jump even though object selection is drawn beside the title. Reveal
        // the title DOM itself, and only when it is actually outside the panel.
        revealRenderedTitleIfNeeded(portal.element);
        return true;
    }

    const parentLabel = view.state.facet(parentLabelFacet);
    const fullLabel = resolveEmbeddedLabel(portal.link, parentLabel);
    const store = useStore.getState();
    const targetBlockId = store.blockIdByLabel[fullLabel];
    if (!targetBlockId) return false;
    const visited = view.state.facet(visitedLabelsFacet);
    const occurrenceKey = promoteTargetOccurrence(view, targetBlockId, portal.link.from);
    store.setActiveBlock(
        targetBlockId,
        forward ? "start" : "end",
        [...visited, fullLabel],
        portal.link.from,
        currentX,
        occurrenceKey
    );
    view.contentDOM.blur();
    return true;
}

/**
 * Treat a rendered embedded title as one word for Option/Alt navigation. The
 * source range for an open title is laid out after its expanded body, so the
 * stock group command's scrollIntoView transaction can reveal that hidden
 * endpoint and move the whole panel. Keep the same group semantics while the
 * selection is on the title, but dispatch without a scroll request.
 */
export function runEmbeddedGroupNavigation(view: EditorView, forward: boolean): boolean {
    if (!view.hasFocus || !view.state.selection.main.empty || completionStatus(view.state) === "active") return false;
    const objectSelection = view.state.field(embeddedObjectSelectionField, false);
    if (!forward && !objectSelection) {
        const suffixLink = openInlineLinkAtSuffixStart(view);
        if (suffixLink) {
            selectOpenTitleEnd(view, suffixLink);
            return true;
        }
    }
    if (!objectSelection) return false;
    const link = view.state.field(parsedLinksField).find(candidate =>
        candidate.from === objectSelection.from && candidate.to === objectSelection.to
    );
    if (!link) return false;

    if (forward && objectSelection.edge === "after" && hasVisibleInlineSuffix(view, link)) {
        selectInlineSuffixStart(view, link);
        return true;
    }

    const selection = view.state.selection.main;
    let next: import("@codemirror/state").SelectionRange;
    if (forward && objectSelection.edge === "before") {
        next = EditorSelection.cursor(link.to, 1);
    } else if (!forward && objectSelection.edge === "after") {
        next = EditorSelection.cursor(link.from, -1);
    } else {
        next = view.moveByGroup(selection, forward);
        if (next.head > link.from && next.head < link.to) {
            next = EditorSelection.cursor(forward ? link.to : link.from, forward ? 1 : -1);
        }
    }

    const nextObjectSelection = next.head === link.from
        ? { from: link.from, to: link.to, edge: "before" as const }
        : next.head === link.to
            ? { from: link.from, to: link.to, edge: "after" as const }
            : null;
    view.dispatch({
        selection: EditorSelection.create([next]),
        effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(nextObjectSelection)]
    });
    return true;
}

export const embedKeymap: KeyBinding[] = [
    {
        key: "ArrowRight",
        run: (view) => {
            if (!view.hasFocus || !view.state.selection.main.empty || completionStatus(view.state) === "active") {
                return false;
            }

            const objectSelection = view.state.field(embeddedObjectSelectionField, false);
            if (objectSelection?.edge === "after") {
                const link = view.state.field(parsedLinksField).find(candidate =>
                    candidate.from === objectSelection.from && candidate.to === objectSelection.to
                );
                if (link && hasVisibleInlineSuffix(view, link)) {
                    selectInlineSuffixStart(view, link);
                    return true;
                }
            }

            const rawLinkEnd = view.state.field(parsedLinksField).find(link =>
                link.to - 1 === view.state.selection.main.head &&
                hasVisibleInlineSuffix(view, link) && isRawEmbeddedSourceVisible(view.state, link)
            );
            if (rawLinkEnd) {
                selectOpenTitleEnd(view, rawLinkEnd);
                return true;
            }

            const head = view.state.selection.main.head;
            const touchedLink = view.state.field(parsedLinksField).find(link => link.from === head);
            if (!touchedLink) return false;

            view.dispatch({
                selection: { anchor: Math.min(touchedLink.from + 2, touchedLink.to) },
                effects: setEditorFocus.of(true),
                scrollIntoView: false
            });
            const fullLabel = resolveEmbeddedLabel(touchedLink, view.state.facet(parentLabelFacet));
            if (!useStore.getState().blockIdByLabel[fullLabel]) startCompletion(view);
            return true;
        }
    },
    {
        key: "ArrowLeft",
        run: (view) => {
            if (!view.hasFocus || !view.state.selection.main.empty || completionStatus(view.state) === "active") {
                return false;
            }

            const suffixLink = openInlineLinkAtSuffixStart(view);
            const objectSelection = view.state.field(embeddedObjectSelectionField, false);
            if (suffixLink && !(objectSelection?.from === suffixLink.from &&
                objectSelection.to === suffixLink.to && objectSelection.edge === "after")) {
                selectOpenTitleEnd(view, suffixLink);
                return true;
            }

            const head = view.state.selection.main.head;
            const touchedLink = view.state.field(parsedLinksField).find(link => link.to === head);
            if (!touchedLink) return false;

            view.dispatch({
                selection: { anchor: Math.max(touchedLink.from, touchedLink.to - 2) },
                effects: setEditorFocus.of(true),
                scrollIntoView: false
            });
            const fullLabel = resolveEmbeddedLabel(touchedLink, view.state.facet(parentLabelFacet));
            if (!useStore.getState().blockIdByLabel[fullLabel]) startCompletion(view);
            return true;
        }
    },
    {
        key: "Backspace",
        run: (view) => {
            if (!view.hasFocus || !view.state.selection.main.empty || completionStatus(view.state) === "active") return false;
            const link = openInlineLinkAtSuffixStart(view);
            const objectSelection = view.state.field(embeddedObjectSelectionField, false);
            if (link && !objectSelection) {
                selectOpenTitleEnd(view, link);
                return true;
            }
            if (link && objectSelection?.from === link.from && objectSelection.edge === "after") {
                view.dispatch({
                    selection: EditorSelection.cursor(Math.max(link.from, link.to - 2)),
                    effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)]
                });
                return true;
            }
            return false;
        }
    },
    {
        key: "Delete",
        run: (view) => {
            if (!view.hasFocus || !view.state.selection.main.empty || completionStatus(view.state) === "active") return false;
            const objectSelection = view.state.field(embeddedObjectSelectionField, false);
            if (objectSelection?.edge !== "after") return false;
            const link = view.state.field(parsedLinksField).find(candidate =>
                candidate.from === objectSelection.from && candidate.to === objectSelection.to
            );
            if (!link || !hasVisibleInlineSuffix(view, link)) return false;
            selectInlineSuffixStart(view, link);
            return true;
        }
    },
    {
        key: "Enter",
        run: (view) => {
            if (!view.hasFocus) return false;
            
            // If autocomplete dropdown is actively open, let it handle the Enter key to select the option
            if (completionStatus(view.state) === "active") {
                return false;
            }
            
            const links = view.state.field(parsedLinksField);
            const selection = view.state.selection.main;
            const parentLabel = view.state.facet(parentLabelFacet);
            
            for (const link of links) {
                if (selection.head >= link.from + 2 && selection.head <= link.to - 2) {
                    const fullLabel = resolveEmbeddedLabel(link, parentLabel);
                    
                    const store = useStore.getState();
                    const isLabelExisted = !!store.blockIdByLabel[fullLabel];
                    
                    if (!isLabelExisted) {
                        // Do not create missing blocks automatically via Enter anymore.
                        return false;
                    } else {
                        // Toggle open/close if it exists
                        const isOpening = !link.open;
                        const inner = setEmbeddedOpen(link.text, isOpening);
                        if (isOpening) markExplicitReopen(view, link.from);
                        
                        const coords = view.coordsAtPos(link.from);
                        const initialY = coords ? coords.top : 0;

                        const newText = `[[${inner}]]`;
                        view.dispatch({
                            changes: { from: link.from, to: link.to, insert: newText },
                            selection: { anchor: link.from + newText.length }
                        });

                        preserveEmbeddedTogglePosition(view, link.from, initialY);

                        if (isOpening) {
                            const store = useStore.getState();
                            const targetBlockId = store.blockIdByLabel[fullLabel];
                            const targetBlock = targetBlockId ? store.blocksById[targetBlockId] : undefined;
                            if (targetBlock) {
                                const visited = view.state.facet(visitedLabelsFacet);
                                setTimeout(() => {
                                    const occurrenceKey = promoteTargetOccurrence(view, targetBlock.id, link.from);
                                    store.setActiveBlock(targetBlock.id, "start", [...visited, fullLabel], link.from, null, occurrenceKey);
                                    view.contentDOM.blur();
                                }, 0);
                            }
                        } else {
                            view.focus();
                        }
                        return true;
                    }
                }
            }
            return false;
        }
    },
    {
        key: "ArrowDown",
        run: (view) => completionStatus(view.state) !== "active" && runVisualEmbeddedNavigation(view, "down")
    },
    {
        key: "ArrowUp",
        run: (view) => completionStatus(view.state) !== "active" && runVisualEmbeddedNavigation(view, "up")
    }
];

export function runEmbeddedKey(view: EditorView, key: "Enter" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Backspace" | "Delete"): boolean {
    const binding = embedKeymap.find(candidate => candidate.key === key);
    return binding?.run ? binding.run(view) : false;
}

export function openEmbeddedTargetInTab(view: EditorView): boolean {
    if (!view.hasFocus || !view.state.selection.main.empty || completionStatus(view.state) === "active") return false;
    const selection = view.state.selection.main;
    const parentLabel = view.state.facet(parentLabelFacet);
    const link = view.state.field(parsedLinksField).find(candidate =>
        selection.head >= candidate.from + 2 && selection.head <= candidate.to - 2
    );
    if (!link) return false;
    const store = useStore.getState();
    const targetId = store.blockIdByLabel[resolveEmbeddedLabel(link, parentLabel)];
    if (!targetId) return false;
    store.openBlockNextToActive(targetId);
    return true;
}

/**
 * Resolve an editor entered from below to its actual final rendered row. If
 * the final source item is another open embed, focusing the source boundary
 * would select that child's title even though its body is visually later.
 * Forward the same end-focus request into the child; each mounted child runs
 * this resolver again, so arbitrary non-circular nesting is handled without a
 * fixed depth limit.
 */
export function enterOpenEmbeddedAtEnd(view: EditorView, x?: number): boolean {
    const doc = view.state.doc;
    const links = view.state.field(parsedLinksField);
    const link = links[links.length - 1];
    if (!link?.open) return false;

    // Spaces after the embed share its final source row. A newline creates a
    // later (possibly empty) visual row and therefore stops inward traversal.
    const trailingSource = doc.sliceString(link.to);
    if (!/^[\t ]*$/.test(trailingSource)) return false;

    const parentLabel = view.state.facet(parentLabelFacet);
    const fullLabel = resolveEmbeddedLabel(link, parentLabel);
    const visited = view.state.facet(visitedLabelsFacet);
    if (visited.includes(fullLabel)) return false;

    const store = useStore.getState();
    const targetBlockId = store.blockIdByLabel[fullLabel];
    if (!targetBlockId) return false;

    const occurrenceKey = promoteTargetOccurrence(view, targetBlockId, link.from);
    store.setActiveBlock(
        targetBlockId,
        "end",
        [...visited, fullLabel],
        link.from,
        x,
        occurrenceKey
    );
    view.contentDOM.blur();
    return true;
}
