import { Decoration, DecorationSet, EditorView, WidgetType, showTooltip, Tooltip, KeyBinding } from "@codemirror/view";
import { RangeSetBuilder, StateField, Facet } from "@codemirror/state";
import { completionStatus } from "@codemirror/autocomplete";
import { editorFocusField, setEditorFocus } from "./katex-plugin";
import { Root, createRoot } from "react-dom/client";
import { EmbeddedBlockUI } from "../../components/EmbeddedBlockUI";
import React from "react";
import { useStore } from "../../store";

export interface ParsedLink {
    from: number;
    to: number;
    text: string;
    rawText: string;
}

export const parentLabelFacet = Facet.define<string, string>({
    combine: values => values[0] || ""
});

export const visitedLabelsFacet = Facet.define<string[], string[]>({
    combine: values => values[0] || []
});

function parseLinks(doc: string): ParsedLink[] {
    const links: ParsedLink[] = [];
    const regex = /\[\[([^\[\]\n]*?)\]\]/g;
    let match;
    while ((match = regex.exec(doc)) !== null) {
        links.push({
            from: match.index,
            to: match.index + match[0].length,
            text: match[1],
            rawText: match[0]
        });
    }
    return links;
}

export const parsedLinksField = StateField.define<ParsedLink[]>({
    create(state) {
        return parseLinks(state.doc.toString());
    },
    update(value, tr) {
        if (tr.docChanged) return parseLinks(tr.state.doc.toString());
        return value;
    }
});

class EmbeddedBlockWidget extends WidgetType {
    root: Root | null = null;

    constructor(
        public text: string, 
        public parentLabel: string, 
        public visitedLabels: string[],
        public from: number, 
        public to: number,
        public isAtEndOfLine: boolean = false
    ) {
        super();
    }

    eq(other: EmbeddedBlockWidget) {
        return this.text === other.text && 
               this.parentLabel === other.parentLabel && 
               JSON.stringify(this.visitedLabels) === JSON.stringify(other.visitedLabels) &&
               this.from === other.from &&
               this.to === other.to &&
               this.isAtEndOfLine === other.isAtEndOfLine;
    }

    toDOM(view: EditorView) {
        const dom = document.createElement("span");
        dom.className = "cm-embedded-block-wrapper text-left";
        
        this.root = createRoot(dom);
        (dom as any).__root = this.root;
        this.root.render(
            <EmbeddedBlockUI 
                text={this.text}
                parentLabel={this.parentLabel}
                visitedLabels={this.visitedLabels}
                view={view}
                pos={this.from}
                length={this.to - this.from}
                isAtEndOfLine={this.isAtEndOfLine}
                toggleOpen={(e?: React.MouseEvent) => {
                    const coords = view.coordsAtPos(this.from);
                    const initialY = coords ? coords.top : 0;

                    const doc = view.state.doc.toString();
                    const slice = doc.slice(this.from, this.to);
                    if (slice.startsWith("[[") && slice.endsWith("]]")) {
                        let inner = slice.slice(2, -2);
                        const isClosing = inner.endsWith("∨");
                        if (isClosing) {
                            inner = inner.slice(0, -1);
                        } else {
                            inner = inner + "∨";
                        }
                        const newText = `[[${inner}]]`;
                        
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
        return dom;
    }

    updateDOM(dom: HTMLElement, view: EditorView) {
        const root = (dom as any).__root as Root;
        if (root) {
            root.render(
                <EmbeddedBlockUI 
                    text={this.text}
                    parentLabel={this.parentLabel}
                    visitedLabels={this.visitedLabels}
                    view={view}
                    pos={this.from}
                    length={this.to - this.from}
                    isAtEndOfLine={this.isAtEndOfLine}
                    toggleOpen={(e?: React.MouseEvent) => {
                        const coords = view.coordsAtPos(this.from);
                        const initialY = coords ? coords.top : 0;

                        const doc = view.state.doc.toString();
                        const slice = doc.slice(this.from, this.to);
                        if (slice.startsWith("[[") && slice.endsWith("]]")) {
                            let inner = slice.slice(2, -2);
                            const isClosing = inner.endsWith("∨");
                            if (isClosing) {
                                inner = inner.slice(0, -1);
                            } else {
                                inner = inner + "∨";
                            }
                            const newText = `[[${inner}]]`;
                            
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
        const root = (dom as any).__root as Root;
        if (root) {
            setTimeout(() => root.unmount(), 0);
        }
    }

    ignoreEvent(e: Event) {
        if (e.target instanceof HTMLElement) {
            const editor = e.target.closest(".cm-editor");
            const wrapper = e.target.closest(".cm-embedded-block-wrapper");
            if (editor && wrapper && wrapper.contains(editor)) return true;
            if (wrapper && (e.target.closest("button") || e.target.tagName === "BUTTON")) return true;
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
    
    const decos: {from: number, to: number, deco: Decoration}[] = [];

    for (const link of links) {
        const isOpen = link.text.endsWith("∨");
        const overlapping = !isOpen && isFocused && (selection.from <= link.to && selection.to >= link.from);

        if (overlapping) {
            decos.push({
                from: link.from,
                to: link.to,
                deco: Decoration.mark({ class: "bg-accent/20 rounded px-1 text-accent" })
            });
        } else {
            const line = state.doc.lineAt(link.to);
            const textAfter = line.text.slice(link.to - line.from);
            const isAtEndOfLine = textAfter.trim() === "";

            decos.push({
                from: link.from,
                to: link.to,
                deco: Decoration.replace({
                    widget: new EmbeddedBlockWidget(link.text, parentLabel, visitedLabels, link.from, link.to, isAtEndOfLine)
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
        if (tr.docChanged || tr.selection || tr.effects.some(e => e.is(setEditorFocus))) {
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
            let rawText = link.text;
            if (rawText.startsWith("@")) rawText = rawText.slice(1);
            if (rawText.endsWith("∨")) rawText = rawText.slice(0, -1);
            
            const pipeIdx = rawText.indexOf("||");
            let rawLabel = pipeIdx !== -1 ? rawText.slice(0, pipeIdx).trim() : rawText.trim();
            
            let fullLabel = rawLabel;
            if (rawLabel.startsWith("/")) {
                fullLabel = parentLabel + rawLabel;
            }

            const store = useStore.getState();
            const isLabelExisted = !!store.blocks.find(b => b.label === fullLabel);

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

export const embedKeymap: KeyBinding[] = [
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
                    let rawText = link.text;
                    if (rawText.startsWith("@")) rawText = rawText.slice(1);
                    if (rawText.endsWith("∨")) rawText = rawText.slice(0, -1);
                    const pipeIdx = rawText.indexOf("||");
                    let rawLabel = pipeIdx !== -1 ? rawText.slice(0, pipeIdx).trim() : rawText.trim();
                    let fullLabel = rawLabel;
                    if (rawLabel.startsWith("/")) fullLabel = parentLabel + rawLabel;
                    
                    const store = useStore.getState();
                    const isLabelExisted = !!store.blocks.find(b => b.label === fullLabel);
                    
                    if (!isLabelExisted) {
                        // Do not create missing blocks automatically via Enter anymore.
                        return false;
                    } else {
                        // Toggle open/close if it exists
                        let inner = link.text;
                        const isOpening = !inner.endsWith("∨");
                        if (isOpening) {
                            inner = inner + "∨";
                        } else {
                            inner = inner.slice(0, -1);
                        }
                        
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
                            const targetBlock = store.blocks.find(b => b.label === fullLabel);
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
        run: (view) => {
            if (!view.hasFocus) return false;
            
            // If autocomplete dropdown is actively open, let it handle the ArrowDown key to select the option
            if (completionStatus(view.state) === "active") {
                return false;
            }

            const selection = view.state.selection.main;
            const links = view.state.field(parsedLinksField);
            const parentLabel = view.state.facet(parentLabelFacet);
            
            const openLinks = links.filter(l => l.text.endsWith("∨"));
            if (openLinks.length === 0) return false;

            const currentLine = view.state.doc.lineAt(selection.head);
            
            let targetLink = null;
            for (const link of openLinks) {
                if (link.from >= selection.head) {
                    const linkLine = view.state.doc.lineAt(link.from);
                    if (linkLine.number === currentLine.number || linkLine.number === currentLine.number + 1) {
                        targetLink = link;
                        break;
                    }
                }
            }
            
            if (targetLink) {
                let rawText = targetLink.text;
                if (rawText.startsWith("@")) rawText = rawText.slice(1);
                if (rawText.endsWith("∨")) rawText = rawText.slice(0, -1);
                const pipeIdx = rawText.indexOf("||");
                let rawLabel = pipeIdx !== -1 ? rawText.slice(0, pipeIdx).trim() : rawText.trim();
                let fullLabel = rawLabel.startsWith("/") ? parentLabel + rawLabel : rawLabel;
                
                const store = useStore.getState();
                const targetBlock = store.blocks.find(b => b.label === fullLabel);
                
                if (targetBlock) {
                    const visited = view.state.facet(visitedLabelsFacet);
                    store.setActiveBlock(targetBlock.id, "start", [...visited, fullLabel], targetLink.from);
                    view.contentDOM.blur();
                    return true;
                }
            }
            return false;
        }
    },
    {
        key: "ArrowUp",
        run: (view) => {
            if (!view.hasFocus) return false;
            
            // If autocomplete dropdown is actively open, let it handle the ArrowUp key to select the option
            if (completionStatus(view.state) === "active") {
                return false;
            }

            const selection = view.state.selection.main;
            const links = view.state.field(parsedLinksField);
            const parentLabel = view.state.facet(parentLabelFacet);
            
            const openLinks = links.filter(l => l.text.endsWith("∨"));
            if (openLinks.length === 0) return false;

            const currentLine = view.state.doc.lineAt(selection.head);
            
            let targetLink = null;
            // Search backwards for ArrowUp
            for (let i = openLinks.length - 1; i >= 0; i--) {
                const link = openLinks[i];
                if (link.to <= selection.head) {
                    const linkLine = view.state.doc.lineAt(link.from);
                    if (linkLine.number === currentLine.number || linkLine.number === currentLine.number - 1) {
                        targetLink = link;
                        break;
                    }
                }
            }
            
            if (targetLink) {
                let rawText = targetLink.text;
                if (rawText.startsWith("@")) rawText = rawText.slice(1);
                if (rawText.endsWith("∨")) rawText = rawText.slice(0, -1);
                const pipeIdx = rawText.indexOf("||");
                let rawLabel = pipeIdx !== -1 ? rawText.slice(0, pipeIdx).trim() : rawText.trim();
                let fullLabel = rawLabel.startsWith("/") ? parentLabel + rawLabel : rawLabel;
                
                const store = useStore.getState();
                const targetBlock = store.blocks.find(b => b.label === fullLabel);
                
                if (targetBlock) {
                    const visited = view.state.facet(visitedLabelsFacet);
                    store.setActiveBlock(targetBlock.id, "end", [...visited, fullLabel], targetLink.from);
                    view.contentDOM.blur();
                    return true;
                }
            }
            return false;
        }
    }
];

