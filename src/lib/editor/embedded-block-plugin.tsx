import { Decoration, DecorationSet, EditorView, WidgetType, showTooltip, Tooltip, KeyBinding } from "@codemirror/view";
import { RangeSetBuilder, StateField, Facet } from "@codemirror/state";
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
    const regex = /\[\[(.*?)\]\]/g;
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
        public to: number
    ) {
        super();
    }

    eq(other: EmbeddedBlockWidget) {
        return this.text === other.text && this.parentLabel === other.parentLabel && JSON.stringify(this.visitedLabels) === JSON.stringify(other.visitedLabels);
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
                toggleOpen={() => {
                    const doc = view.state.doc.toString();
                    const slice = doc.slice(this.from, this.to);
                    if (slice.startsWith("[[") && slice.endsWith("]]")) {
                        let inner = slice.slice(2, -2);
                        if (inner.endsWith("∨")) {
                            inner = inner.slice(0, -1);
                        } else {
                            inner = inner + "∨";
                        }
                        const newText = `[[${inner}]]`;
                        view.dispatch({
                            changes: { from: this.from, to: this.to, insert: newText },
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
                    toggleOpen={() => {
                        const doc = view.state.doc.toString();
                        const slice = doc.slice(this.from, this.to);
                        if (slice.startsWith("[[") && slice.endsWith("]]")) {
                            let inner = slice.slice(2, -2);
                            if (inner.endsWith("∨")) {
                                inner = inner.slice(0, -1);
                            } else {
                                inner = inner + "∨";
                            }
                            const newText = `[[${inner}]]`;
                            view.dispatch({
                                changes: { from: this.from, to: this.to, insert: newText },
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
            if (e.target.closest(".cm-editor")) return true;
            if (e.target.closest("button") || e.target.tagName === "BUTTON") return true;
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
            decos.push({
                from: link.from,
                to: link.to,
                deco: Decoration.replace({
                    widget: new EmbeddedBlockWidget(link.text, parentLabel, visitedLabels, link.from, link.to)
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
        const overlapping = selection.from <= link.to && selection.to >= link.from;
        if (overlapping) {
            let rawText = link.text;
            if (rawText.startsWith("@")) rawText = rawText.slice(1);
            if (rawText.endsWith("∨")) rawText = rawText.slice(0, -1);
            
            const pipeIdx = rawText.indexOf("|");
            let rawLabel = pipeIdx !== -1 ? rawText.slice(0, pipeIdx).trim() : rawText.trim();
            
            let fullLabel = rawLabel;
            if (rawLabel.startsWith("/")) {
                fullLabel = parentLabel + rawLabel;
            }

            const blocks = useStore.getState().blocks;
            const isLabelExisted = !!blocks.find(b => b.label === fullLabel);

            if (!isLabelExisted) {
                return {
                    pos: link.from,
                    above: true,
                    create(view: EditorView) {
                        const dom = document.createElement("div");
                        dom.className = "flex items-center gap-2 p-2 bg-surface text-[15px] border border-outline shadow-lg rounded-xl text-primary z-50 mb-3 mx-2 pointer-events-none";
                        
                        const icon = document.createElement("span");
                        icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-circle text-accent"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>`;
                        
                        const textObj = document.createElement("span");
                        textObj.className = "text-sm text-secondary font-medium";
                        textObj.innerHTML = `Press <kbd class="px-[5px] py-[2px] bg-neutral-800 rounded mx-1 text-xs text-primary border border-neutral-700 shadow-sm font-sans mx-1">Enter</kbd> to create <b class="text-accent underline decoration-dotted underline-offset-4 ml-1">${fullLabel}</b>`;
                        
                        dom.appendChild(icon);
                        dom.appendChild(textObj);

                        return { dom };
                    }
                };
            } else {
                return {
                    pos: link.from,
                    above: true,
                    create(view: EditorView) {
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
            
            const links = view.state.field(parsedLinksField);
            const selection = view.state.selection.main;
            const parentLabel = view.state.facet(parentLabelFacet);
            
            for (const link of links) {
                if (selection.from <= link.to && selection.to >= link.from) {
                    let rawText = link.text;
                    if (rawText.startsWith("@")) rawText = rawText.slice(1);
                    if (rawText.endsWith("∨")) rawText = rawText.slice(0, -1);
                    const pipeIdx = rawText.indexOf("|");
                    let rawLabel = pipeIdx !== -1 ? rawText.slice(0, pipeIdx).trim() : rawText.trim();
                    let fullLabel = rawLabel;
                    if (rawLabel.startsWith("/")) fullLabel = parentLabel + rawLabel;
                    
                    const store = useStore.getState();
                    const isLabelExisted = !!store.blocks.find(b => b.label === fullLabel);
                    
                    if (!isLabelExisted) {
                        let newTitle = pipeIdx !== -1 ? rawText.slice(pipeIdx + 1).trim() : rawLabel;
                        
                        store.addBlock(-1, { title: newTitle, label: fullLabel, content: "" }).then((newBlock) => {
                            let inner = link.text;
                            if (!inner.endsWith("∨")) {
                                view.dispatch({
                                    changes: { from: link.from, to: link.to, insert: `[[${inner}∨]]` }
                                });
                            }
                            
                            if (newBlock) {
                                const visited = view.state.facet(visitedLabelsFacet);
                                useStore.getState().setActiveBlock(newBlock.id, "start", [...visited, fullLabel]);
                                view.contentDOM.blur();
                            }
                        });
                        return true;
                    } else {
                        // Toggle open/close if it exists
                        let inner = link.text;
                        const isOpening = !inner.endsWith("∨");
                        if (isOpening) {
                            inner = inner + "∨";
                        } else {
                            inner = inner.slice(0, -1);
                        }
                        const newText = `[[${inner}]]`;
                        view.dispatch({
                            changes: { from: link.from, to: link.to, insert: newText },
                            selection: { anchor: link.from + newText.length }
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
                const pipeIdx = rawText.indexOf("|");
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
                const pipeIdx = rawText.indexOf("|");
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

