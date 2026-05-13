import { Decoration, DecorationSet, EditorView, WidgetType, showTooltip, Tooltip } from "@codemirror/view";
import { RangeSetBuilder, StateField, EditorState, Facet, StateEffect } from "@codemirror/state";
import katex from "katex";
import "katex/dist/katex.min.css"; 

export const livePreviewMacros = Facet.define<Record<string, string>, Record<string, string>>({
    combine: values => values[0] || {}
});

export const setEditorFocus = StateEffect.define<boolean>();

export const editorFocusField = StateField.define<boolean>({
    create() { return false; },
    update(value, tr) {
        for (let e of tr.effects) {
            if (e.is(setEditorFocus)) return e.value;
        }
        return value;
    }
});

export interface ParsedRange {
    from: number;
    to: number;
    text: string;
    type: "blockMath" | "inlineMath" | "bold" | "italic" | "underline" | "list";
}

function parseRanges(doc: string): ParsedRange[] {
    const ranges: ParsedRange[] = [];
    
    let i = 0;
    while (i < doc.length) {
        if (doc.startsWith("$$", i)) {
            let end = doc.indexOf("$$", i + 2);
            if (end !== -1) {
                ranges.push({
                    from: i, 
                    to: end + 2, 
                    text: doc.slice(i + 2, end).trim(),
                    type: "blockMath"
                });
                i = end + 2;
                continue;
            }
        }
        i++;
    }

    i = 0;
    while (i < doc.length) {
        const blockOverlap = ranges.find(r => r.type === "blockMath" && i >= r.from && i < r.to);
        if (blockOverlap) {
            i = blockOverlap.to;
            continue;
        }

        if (doc[i] === '$' && doc[i-1] !== '\\') {
            let end = doc.indexOf("$", i + 1);
            while (end !== -1 && doc[end - 1] === '\\') {
                end = doc.indexOf("$", end + 1);
            }
            if (end !== -1) {
                ranges.push({
                    from: i, 
                    to: end + 1, 
                    text: doc.slice(i + 1, end).trim(),
                    type: "inlineMath"
                });
                i = end + 1;
                continue;
            }
        }
        i++;
    }

    const boldRegex = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
    let match;
    while ((match = boldRegex.exec(doc)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const overlapping = ranges.some(r => Math.max(start, r.from) < Math.min(end, r.to));
        if (!overlapping) {
            ranges.push({
                from: start,
                to: end,
                text: match[1],
                type: "bold"
            });
        }
    }

    const italicRegex = /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g;
    while ((match = italicRegex.exec(doc)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const text = match[1];
        const overlapping = ranges.some(r => Math.max(start, r.from) < Math.min(end, r.to));
        if (!overlapping) {
            ranges.push({
                from: start,
                to: end,
                text: text,
                type: "italic"
            });
        }
    }

    const underlineRegex = /(?<!_)_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g;
    while ((match = underlineRegex.exec(doc)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const text = match[1];
        const overlapping = ranges.some(r => Math.max(start, r.from) < Math.min(end, r.to));
        if (!overlapping) {
            ranges.push({
                from: start,
                to: end,
                text: text,
                type: "underline"
            });
        }
    }

    const listRegex = /^[ \t]*(\*)(?=\s)/gm;
    while ((match = listRegex.exec(doc)) !== null) {
        const start = match.index + match[0].length - 1;
        const end = start + 1;
        const overlapping = ranges.some(r => Math.max(start, r.from) < Math.min(end, r.to));
        if (!overlapping) {
            ranges.push({
                from: start,
                to: end,
                text: "*",
                type: "list"
            });
        }
    }

    ranges.sort((a, b) => a.from - b.from);
    return ranges;
}

export const parsedRangesField = StateField.define<ParsedRange[]>({
    create(state) {
        return parseRanges(state.doc.toString());
    },
    update(value, tr) {
        if (tr.docChanged) return parseRanges(tr.state.doc.toString());
        return value;
    }
});

class MathWidget extends WidgetType {
    constructor(public text: string, public isBlock: boolean, public macros: Record<string, string>) {
        super();
    }

    eq(other: MathWidget) {
        return this.text === other.text && this.isBlock === other.isBlock && this.macros === other.macros;
    }

    toDOM(view: EditorView) {
        const span = document.createElement(this.isBlock ? "div" : "span");
        span.className = this.isBlock ? "cm-math-block my-0 text-center" : "cm-math-inline";
        span.style.cursor = "text";
        try {
            katex.render(this.text, span, {
                displayMode: this.isBlock,
                throwOnError: true,
                macros: {...this.macros}
            });
        } catch (e: any) {
            span.innerText = this.text;
            span.className += " text-red-500 bg-red-500/10 px-1 rounded";
            span.title = e.message;
        }
        return span;
    }

    ignoreEvent() {
        return false;
    }
}

class BlockMathEditingPreviewWidget extends WidgetType {
    constructor(public text: string, public macros: Record<string, string>) {
        super();
    }

    eq(other: BlockMathEditingPreviewWidget) {
        return this.text === other.text && this.macros === other.macros;
    }

    toDOM() {
        const dom = document.createElement("div");
        dom.className = "cm-math-block my-0 text-center pointer-events-none"; 
        try {
            katex.render(this.text, dom, {
                displayMode: true,
                throwOnError: true,
                macros: {...this.macros}
            });
        } catch (e: any) {
            dom.innerText = this.text;
            dom.className += " text-red-500 bg-red-500/10 px-1 rounded";
        }
        return dom;
    }

    ignoreEvent() { return true; }
}


class ListWidget extends WidgetType {
    eq() { return true; }
    toDOM() {
        const span = document.createElement("span");
        span.className = "text-accent mx-2 rounded-full w-1.5 h-1.5 bg-accent inline-block transform -translate-y-[2px]";
        return span;
    }
    ignoreEvent() { return false; }
}

function buildLiveDecorations(state: EditorState) {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = state.doc.toString();
    const macros = state.facet(livePreviewMacros);
    const isFocused = state.field(editorFocusField, false);
    const ranges = state.field(parsedRangesField);
    
    const selection = state.selection.main;
    const decos: {from: number, to: number, deco: Decoration}[] = [];

    for (const r of ranges) {
        // Only evaluate overlapping logic if the editor actually has DOM focus (isFocused).
        // Otherwise, it should render the widgets because the user clicked away.
        const overlapping = (isFocused !== false) && (selection.from <= r.to && selection.to >= r.from);
        
        if (overlapping) {
            let editClass = "cm-math-editing";
            if (r.type === "bold" || r.type === "italic" || r.type === "underline") {
                editClass = "bg-neutral-800/80 text-blue-300 rounded px-1";
            } else if (r.type === "list") {
                editClass = "text-blue-400 font-bold";
            }
            
            // 1. The outer background wrapping
            decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: editClass })});

            // 2. Syntax highlighting specifically for math zones
            if (r.type === "blockMath" || r.type === "inlineMath") {
                const mathText = doc.slice(r.from, r.to);
                const tokens: {from: number, to: number, class: string}[] = [];
                
                let m;
                // Comments %
                const commentRegex = /%.*/g;
                while ((m = commentRegex.exec(mathText)) !== null) {
                    tokens.push({ from: m.index, to: m.index + m[0].length, class: "text-gray-500 italic" });
                }

                const inComment = (index: number) => tokens.some(t => t.class.includes('gray') && index >= t.from && index < t.to);

                // Commands \something
                const cmdRegex = /\\[a-zA-Z]+/g;
                while ((m = cmdRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + m[0].length, class: "text-[#61afef]" });
                }

                // Escaped symbols (\%, \{, \_)
                const escRegex = /\\([{}%$_\\])/g;
                while ((m = escRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 2, class: "text-[#56b6c2]" });
                }

                // Braces {}
                const braceRegex = /[{}]/g;
                while ((m = braceRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 1, class: "text-[#e5c07b]" });
                }

                // Sub/superscript _ ^
                const scriptRegex = /[_^]/g;
                while ((m = scriptRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 1, class: "text-[#c678dd]" });
                }

                // Alignment &
                const ampRegex = /&/g;
                while ((m = ampRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 1, class: "text-[#e06c75]" });
                }

                for (const t of tokens) {
                    decos.push({
                        from: r.from + t.from,
                        to: r.from + t.to,
                        deco: Decoration.mark({ class: t.class })
                    });
                }

                // Math Delimiters ($ and $$) overleaf-green
                if (r.type === "blockMath") {
                    decos.push({ from: r.from, to: r.from + 2, deco: Decoration.mark({ class: "text-[#98c379] font-bold" }) });
                    decos.push({ from: r.to - 2, to: r.to, deco: Decoration.mark({ class: "text-[#98c379] font-bold" }) });
                } else if (r.type === "inlineMath") {
                    decos.push({ from: r.from, to: r.from + 1, deco: Decoration.mark({ class: "text-[#98c379] font-bold" }) });
                    decos.push({ from: r.to - 1, to: r.to, deco: Decoration.mark({ class: "text-[#98c379] font-bold" }) });
                }
            }

            // 3. Inject live-preview below block math edits while focused!
            if (r.type === "blockMath") {
                decos.push({
                    from: r.to,
                    to: r.to,
                    deco: Decoration.widget({
                        widget: new BlockMathEditingPreviewWidget(r.text, macros),
                        block: true,
                        side: 1 // underneath
                    })
                });
            }

        } else {
            if (r.type === "bold") {
                decos.push({from: r.from, to: r.from + 2, deco: Decoration.replace({})});
                decos.push({from: r.from + 2, to: r.to - 2, deco: Decoration.mark({ class: "font-bold text-primary" })});
                decos.push({from: r.to - 2, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "italic") {
                decos.push({from: r.from, to: r.from + 1, deco: Decoration.replace({})});
                decos.push({from: r.from + 1, to: r.to - 1, deco: Decoration.mark({ class: "italic text-primary" })});
                decos.push({from: r.to - 1, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "underline") {
                decos.push({from: r.from, to: r.from + 1, deco: Decoration.replace({})});
                decos.push({from: r.from + 1, to: r.to - 1, deco: Decoration.mark({ class: "underline underline-offset-2 text-primary" })});
                decos.push({from: r.to - 1, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "list") {
                decos.push({from: r.from, to: r.to, deco: Decoration.replace({
                    widget: new ListWidget()
                })});
            } else {
                decos.push({from: r.from, to: r.to, deco: Decoration.replace({
                    widget: new MathWidget(r.text, r.type === "blockMath", macros)
                })});
            }
        }
    }

    // Sort to satisfy RangeSetBuilder constraints: strictly increasing `from`, decreasing `to`.
    decos.sort((a, b) => a.from - b.from || b.to - a.to);

    for (const d of decos) {
        builder.add(d.from, d.to, d.deco);
    }

    return builder.finish();
}

export const mathPlugin = StateField.define<DecorationSet>({
    create(state) {
        return buildLiveDecorations(state);
    },
    update(decorations, tr) {
        const macrosChanged = tr.state.facet(livePreviewMacros) !== tr.startState.facet(livePreviewMacros);
        if (tr.docChanged || tr.selection || macrosChanged || tr.effects.some(e => e.is(setEditorFocus))) {
            return buildLiveDecorations(tr.state);
        }
        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

function getMathTooltip(state: EditorState): Tooltip | null {
    const isFocused = state.field(editorFocusField, false);
    if (!isFocused) return null;

    const ranges = state.field(parsedRangesField);
    const selection = state.selection.main;
    const macros = state.facet(livePreviewMacros);

    for (const r of ranges) {
        if (r.type === "inlineMath") {
            const overlapping = selection.from <= r.to && selection.to >= r.from;
            if (overlapping) {
                return {
                    pos: r.from,
                    above: true,
                    create(view: EditorView) {
                        let currentText = r.text;
                        const dom = document.createElement("div");
                        dom.className = "p-3 bg-surface border border-outline shadow-lg rounded-xl text-primary z-50 pointer-events-none mb-3 max-w-[90vw]";
                        
                        const renderMath = (text: string) => {
                            try {
                                katex.render(text, dom, {
                                    displayMode: false,
                                    throwOnError: true,
                                    macros: {...macros}
                                });
                                dom.className = "p-3 bg-surface border border-outline shadow-lg rounded-xl text-primary z-50 pointer-events-none mb-3 max-w-[90vw]";
                            } catch (e: any) {
                                dom.innerText = text;
                                dom.className = "p-3 bg-surface border border-outline shadow-lg rounded-xl text-primary z-50 pointer-events-none mb-3 max-w-[90vw] text-red-500 bg-red-500/10 font-mono text-sm";
                            }
                        };
                        
                        renderMath(currentText);

                        return {
                            dom,
                            update(update) {
                                const newRanges = update.state.field(parsedRangesField);
                                const newSelection = update.state.selection.main;
                                // Find if we are still overlapping an inline math, and if the text has changed
                                const activeRange = newRanges.find(nr => 
                                    nr.type === "inlineMath" && 
                                    newSelection.from <= nr.to && 
                                    newSelection.to >= nr.from &&
                                    nr.from === r.from // Pos remains the same anchor
                                );
                                
                                if (activeRange && activeRange.text !== currentText) {
                                    currentText = activeRange.text;
                                    renderMath(currentText);
                                }
                            }
                        };
                    }
                };
            }
        }
    }
    return null;
}

export const mathTooltipField = showTooltip.compute(
    ["doc", "selection", editorFocusField, parsedRangesField],
    (state) => {
        return getMathTooltip(state);
    }
);
