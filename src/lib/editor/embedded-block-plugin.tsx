import { Decoration, DecorationSet, EditorView, WidgetType, showTooltip, Tooltip, KeyBinding } from "@codemirror/view";
import { EditorSelection, RangeSetBuilder, StateField, Facet } from "@codemirror/state";
import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { editorFocusField, setEditorFocus } from "./katex-plugin";
import { Root, createRoot } from "react-dom/client";
import { EmbeddedBlockUI } from "../../components/EmbeddedBlockUI";
import React from "react";
import { useStore } from "../../store";
import { EmbeddedLinkSyntax, parseEmbeddedLinks, resolveEmbeddedLabel, setEmbeddedOpen } from "../embedded-link-syntax";
import { EmbeddedObjectSelection, setEmbeddedObjectSelection } from "./embedded-object-selection";

export { setEmbeddedObjectSelection } from "./embedded-object-selection";

export type ParsedLink = EmbeddedLinkSyntax;

export const parentLabelFacet = Facet.define<string, string>({
    combine: values => values[0] || ""
});

export const visitedLabelsFacet = Facet.define<string[], string[]>({
    combine: values => values[0] || []
});

export const parsedLinksField = StateField.define<ParsedLink[]>({
    create(state) {
        return parseEmbeddedLinks(state.doc.toString());
    },
    update(value, tr) {
        if (tr.docChanged) return parseEmbeddedLinks(tr.state.doc.toString());
        return value;
    }
});

const embedWrappersByView = new WeakMap<EditorView, Set<HTMLElement>>();

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

function getEmbeddedObjectSelection(state: import("@codemirror/state").EditorState): EmbeddedObjectSelection | null {
    if (!state.field(editorFocusField, false)) return null;

    const selection = state.selection.main;
    if (!selection.empty) return null;

    for (const link of state.field(parsedLinksField)) {
        if (selection.head === link.from) {
            return { from: link.from, to: link.to, edge: "before" };
        }
        if (selection.head === link.to) {
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

class EmbeddedBlockWidget extends WidgetType {
    root: Root | null = null;
    ownerView: EditorView | null = null;

    public stateRef: { pos: number, length: number };
    constructor(
        public text: string, 
        public parentLabel: string, 
        public visitedLabels: string[],
        public from: number, 
        public to: number,
        public isAtEndOfLine: boolean = false,
        public isAtStartOfLine: boolean = false,
        public isKeyboardSelected: boolean = false,
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
               this.from === other.from &&
               this.to === other.to &&
               this.isAtEndOfLine === other.isAtEndOfLine &&
               this.isAtStartOfLine === other.isAtStartOfLine &&
               this.isKeyboardSelected === other.isKeyboardSelected;
    }

    toDOM(view: EditorView) {
        const dom = document.createElement("span");
        dom.className = "cm-embedded-block-wrapper text-left";
        dom.dataset.embedFrom = String(this.from);
        dom.dataset.embedTo = String(this.to);
        this.ownerView = view;
        registerEmbedWrapper(view, dom);
        
        this.root = createRoot(dom);
        (dom as any).__root = this.root;
        this.root.render(
            <EmbeddedBlockUI 
                text={this.text}
                parentLabel={this.parentLabel}
                visitedLabels={this.visitedLabels}
                view={view}
                stateRef={this.stateRef}
                isAtEndOfLine={this.isAtEndOfLine}
                isAtStartOfLine={this.isAtStartOfLine}
                isKeyboardSelected={this.isKeyboardSelected}
                toggleOpen={(e?: React.MouseEvent) => {
                    const coords = view.coordsAtPos(this.from);
                    const initialY = coords ? coords.top : 0;

                    const doc = view.state.doc.toString();
                    const slice = doc.slice(this.from, this.to);
                    if (slice.startsWith("[[") && slice.endsWith("]]")) {
                        const inner = slice.slice(2, -2);
                        const isClosing = parseEmbeddedLinks(slice)[0]?.open ?? false;
                        const toggledText = `[[${setEmbeddedOpen(inner, !isClosing)}]]`;
                        
                        if (isClosing && !e) {
                            view.dispatch({
                                changes: { from: this.from, to: this.to, insert: toggledText },
                                selection: { anchor: this.from + toggledText.length }
                            });
                            view.focus();
                        } else {
                            view.dispatch({
                                changes: { from: this.from, to: this.to, insert: toggledText },
                            });
                        }

                        requestAnimationFrame(() => {
                            const newCoords = view.coordsAtPos(this.from);
                            const newY = newCoords ? newCoords.top : 0;
                            
                            if (initialY && newY && newY !== initialY) {
                                window.scrollBy(0, newY - initialY);
                            }
                        });
                    }
                }}
            />
        );
        return dom;
    }

    updateDOM(dom: HTMLElement, view: EditorView) {
        if (this.ownerView !== view) unregisterEmbedWrapper(this.ownerView, dom);
        this.ownerView = view;
        registerEmbedWrapper(view, dom);
        dom.dataset.embedFrom = String(this.from);
        dom.dataset.embedTo = String(this.to);
        const root = (dom as any).__root as Root;
        if (root) {
            root.render(
                <EmbeddedBlockUI 
                    text={this.text}
                    parentLabel={this.parentLabel}
                    visitedLabels={this.visitedLabels}
                    view={view}
                    stateRef={this.stateRef}
                    isAtEndOfLine={this.isAtEndOfLine}
                    isAtStartOfLine={this.isAtStartOfLine}
                    isKeyboardSelected={this.isKeyboardSelected}
                    toggleOpen={(e?: React.MouseEvent) => {
                        const coords = view.coordsAtPos(this.from);
                        const initialY = coords ? coords.top : 0;

                        const doc = view.state.doc.toString();
                        const slice = doc.slice(this.from, this.to);
                        if (slice.startsWith("[[") && slice.endsWith("]]")) {
                            const inner = slice.slice(2, -2);
                            const isClosing = parseEmbeddedLinks(slice)[0]?.open ?? false;
                            const newText = `[[${setEmbeddedOpen(inner, !isClosing)}]]`;
                            
                            if (isClosing && !e) {
                                view.dispatch({
                                    changes: { from: this.from, to: this.to, insert: newText },
                                    selection: { anchor: this.from + newText.length }
                                });
                                view.focus();
                            } else {
                                view.dispatch({
                                    changes: { from: this.from, to: this.to, insert: newText },
                                });
                            }

                            requestAnimationFrame(() => {
                                const newCoords = view.coordsAtPos(this.from);
                                const newY = newCoords ? newCoords.top : 0;
                                
                                if (initialY && newY && newY !== initialY) {
                                    window.scrollBy(0, newY - initialY);
                                }
                            });
                        }
                    }}
                />
            );
            return true;
        }
        return false;
    }

    destroy(dom: HTMLElement) {
        unregisterEmbedWrapper(this.ownerView, dom);
        this.ownerView = null;
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
                deco: Decoration.mark({ class: "bg-accent/20 rounded px-1 text-accent", inclusive: true })
            });
        } else {
            const line = state.doc.lineAt(link.to);
            const textAfter = line.text.slice(link.to - line.from);
            const isAtEndOfLine = textAfter.trim() === "";
            const textBefore = line.text.slice(0, link.from - line.from);
            const isAtStartOfLine = textBefore.trim() === "";

            decos.push({
                from: link.from,
                to: link.to,
                deco: Decoration.replace({
                    widget: new EmbeddedBlockWidget(
                        link.text,
                        parentLabel,
                        visitedLabels,
                        link.from,
                        link.to,
                        isAtEndOfLine,
                        isAtStartOfLine,
                        isKeyboardSelected
                    )
                })
            });
        }
    }

    decos.sort((a, b) => a.from - b.from || b.to - a.to);

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
                        textObj.innerHTML = `Press <kbd class="px-[5px] py-[2px] bg-neutral-800 rounded mx-1 text-xs text-primary border border-neutral-700 shadow-sm font-sans mx-1">Enter</kbd> to open/close`;
                        
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
        view.dispatch({
            selection: EditorSelection.create([EditorSelection.cursor(anchor, forward ? 1 : -1)]),
            effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
            scrollIntoView: true
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
    view.dispatch({
        selection: { anchor },
        effects: [setEditorFocus.of(true), setEmbeddedObjectSelection.of(null)],
        scrollIntoView: true
    });
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

    const objectSelection = view.state.field(embeddedObjectSelectionField, false);
    const registeredWrappers = embedWrappersByView.get(view);
    const ownedWrappers = registeredWrappers
        ? Array.from(registeredWrappers).filter(wrapper => {
            if (!wrapper.isConnected) {
                registeredWrappers.delete(wrapper);
                return false;
            }
            return wrapper.closest(".cm-editor") === view.dom;
        })
        : [];

    let currentTop: number | null = null;
    let currentBottom: number | null = null;
    if (objectSelection) {
        const selectedWrapper = ownedWrappers.find(wrapper =>
            Number(wrapper.dataset.embedFrom) === objectSelection.from &&
            Number(wrapper.dataset.embedTo) === objectSelection.to
        );
        const selectedTitle = selectedWrapper && directEmbedElement(selectedWrapper, "[data-embed-nav-title]");
        if (selectedTitle) {
            const rect = selectedTitle.getBoundingClientRect();
            currentTop = rect.top;
            currentBottom = rect.bottom;
        }
    }

    if (currentTop === null || currentBottom === null) {
        const selectionSide = selection.assoc < 0 ? -1 : selection.assoc > 0 ? 1 : (direction === "down" ? 1 : -1);
        const caret = view.coordsAtPos(selection.head, selectionSide);
        if (!caret) return false;
        currentTop = caret.top;
        currentBottom = caret.bottom;
    }

    const currentCoordinate = (currentTop + currentBottom) / 2;
    const currentX = view.coordsAtPos(selection.head)?.left ?? view.dom.getBoundingClientRect().left;
    const lineHeight = view.defaultLineHeight;

    if (objectSelection) {
        const selectedLink = links.find(link =>
            link.from === objectSelection.from && link.to === objectSelection.to
        );
        const selectedWrapper = ownedWrappers.find(wrapper =>
            Number(wrapper.dataset.embedFrom) === objectSelection.from &&
            Number(wrapper.dataset.embedTo) === objectSelection.to
        );
        const selectedTitle = selectedWrapper && directEmbedElement(selectedWrapper, "[data-embed-nav-title]");
        if (selectedLink?.standout && !selectedLink.open && selectedTitle) {
            return movePastClosedStandoutTitle(view, selectedLink, selectedTitle, direction, currentX);
        }
    }

    const forward = direction === "down";
    const normalMove = view.moveVertically(selection, forward);
    const normalCoords = normalMove.head === selection.head
        ? null
        : view.coordsAtPos(normalMove.head, forward ? 1 : -1);
    const normalCoordinate = normalCoords ? (normalCoords.top + normalCoords.bottom) / 2 : null;
    const normalDistance = normalCoordinate === null
        ? Number.POSITIVE_INFINITY
        : (forward ? normalCoordinate - currentCoordinate : currentCoordinate - normalCoordinate);

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
    // When CodeMirror already has a destination on the same visual row, let its
    // native movement win. This preserves ordinary text before/after embeds.
    if (!portal || (!entersSelectedBody && portal.distance >= normalDistance - 2)) return false;

    if (portal.kind === "title") {
        const rect = portal.element.getBoundingClientRect();
        const anchor = currentX > (rect.left + rect.right) / 2 ? portal.link.to : portal.link.from;
        view.dispatch({
            selection: { anchor },
            effects: [
                setEditorFocus.of(true),
                setEmbeddedObjectSelection.of({
                    from: portal.link.from,
                    to: portal.link.to,
                    edge: anchor === portal.link.from ? "before" : "after"
                })
            ],
            scrollIntoView: true
        });
        return true;
    }

    const parentLabel = view.state.facet(parentLabelFacet);
    const fullLabel = resolveEmbeddedLabel(portal.link, parentLabel);
    const store = useStore.getState();
    const targetBlockId = store.blockIdByLabel[fullLabel];
    if (!targetBlockId) return false;
    const visited = view.state.facet(visitedLabelsFacet);
    store.setActiveBlock(
        targetBlockId,
        forward ? "start" : "end",
        [...visited, fullLabel],
        portal.link.from,
        currentX
    );
    view.contentDOM.blur();
    return true;
}

export const embedKeymap: KeyBinding[] = [
    {
        key: "ArrowRight",
        run: (view) => {
            if (!view.hasFocus || !view.state.selection.main.empty || completionStatus(view.state) === "active") {
                return false;
            }

            const head = view.state.selection.main.head;
            const touchedLink = view.state.field(parsedLinksField).find(link => link.from === head);
            if (!touchedLink) return false;

            view.dispatch({
                selection: { anchor: Math.min(touchedLink.from + 2, touchedLink.to) },
                effects: setEditorFocus.of(true),
                scrollIntoView: true
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

            const head = view.state.selection.main.head;
            const touchedLink = view.state.field(parsedLinksField).find(link => link.to === head);
            if (!touchedLink) return false;

            view.dispatch({
                selection: { anchor: Math.max(touchedLink.from, touchedLink.to - 2) },
                effects: setEditorFocus.of(true),
                scrollIntoView: true
            });
            const fullLabel = resolveEmbeddedLabel(touchedLink, view.state.facet(parentLabelFacet));
            if (!useStore.getState().blockIdByLabel[fullLabel]) startCompletion(view);
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
                        
                        const coords = view.coordsAtPos(link.from);
                        const initialY = coords ? coords.top : 0;

                        const newText = `[[${inner}]]`;
                        view.dispatch({
                            changes: { from: link.from, to: link.to, insert: newText },
                            selection: { anchor: link.from + newText.length }
                        });

                        requestAnimationFrame(() => {
                            const newCoords = view.coordsAtPos(link.from);
                            const newY = newCoords ? newCoords.top : 0;
                            if (initialY && newY && newY !== initialY) {
                                window.scrollBy(0, newY - initialY);
                            }
                        });

                        if (isOpening) {
                            const store = useStore.getState();
                            const targetBlockId = store.blockIdByLabel[fullLabel];
                            const targetBlock = targetBlockId ? store.blocksById[targetBlockId] : undefined;
                            if (targetBlock) {
                                const visited = view.state.facet(visitedLabelsFacet);
                                setTimeout(() => {
                                    store.setActiveBlock(targetBlock.id, "start", [...visited, fullLabel], link.from);
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

export function runEmbeddedKey(view: EditorView, key: "Enter" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"): boolean {
    const binding = embedKeymap.find(candidate => candidate.key === key);
    return binding?.run ? binding.run(view) : false;
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

    store.setActiveBlock(
        targetBlockId,
        "end",
        [...visited, fullLabel],
        link.from,
        x
    );
    view.contentDOM.blur();
    return true;
}
