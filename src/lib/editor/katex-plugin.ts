import { Decoration, DecorationSet, EditorView, WidgetType, showTooltip, Tooltip } from "@codemirror/view";
import { RangeSetBuilder, StateField, EditorState, Facet, StateEffect } from "@codemirror/state";
import katex from "katex";
import "katex/dist/katex.min.css"; 

export const livePreviewMacros = Facet.define<Record<string, string>, Record<string, string>>({
    combine: values => values[0] || {}
});

export const setEditorFocus = StateEffect.define<boolean>();

interface AutoClosingDollarChange {
    add?: number;
    remove?: number;
}

export const updateAutoClosingDollar = StateEffect.define<AutoClosingDollarChange>();

export const autoClosingDollarField = StateField.define<Set<number>>({
    create() {
        return new Set();
    },
    update(value, tr) {
        const next = new Set<number>();
        for (const pos of value) {
            const mapped = tr.changes.mapPos(pos, 1);
            if (tr.state.doc.sliceString(mapped, mapped + 1) === "$") next.add(mapped);
        }

        for (const effect of tr.effects) {
            if (!effect.is(updateAutoClosingDollar)) continue;
            if (effect.value.remove !== undefined) next.delete(effect.value.remove);
            if (effect.value.add !== undefined && tr.state.doc.sliceString(effect.value.add, effect.value.add + 1) === "$") {
                next.add(effect.value.add);
            }
        }
        return next;
    }
});

export const editorFocusField = StateField.define<boolean>({
    create(state) { 
        // Initial value could be true if the DOM is already focused or we are just typing
        // But let's just default to true if the editor is active or we don't want to prematurely widgetize
        return true; 
    },
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
    type: "blockMath" | "inlineMath" | "bold" | "italic" | "underline" | "list" | "quote" | "link";
    url?: string;
    labelFrom?: number;
    labelTo?: number;
}

export function isDollarEscaped(doc: string, pos: number) {
    let backslashes = 0;
    for (let i = pos - 1; i >= 0 && doc[i] === "\\"; i--) backslashes++;
    return backslashes % 2 === 1;
}

function parseRanges(doc: string, autoClosingDollars: ReadonlySet<number> = new Set()): ParsedRange[] {
    const ranges: ParsedRange[] = [];

    // Display math may span lines, so identify it before scanning individual
    // lines for inline math.
    let i = 0;
    while (i < doc.length) {
        if (doc.startsWith("\\[", i)) {
            let end = doc.indexOf("\\]", i + 2);
            if (end !== -1) {
                const text = doc.slice(i + 2, end).trim();
                if (text.length > 0) {
                    ranges.push({
                        from: i, 
                        to: end + 2, 
                        text: text,
                        type: "blockMath"
                    });
                    i = end + 2;
                    continue;
                }
            }
        }
        i++;
    }

    const blockMathRanges = ranges.filter(r => r.type === "blockMath");
    let lineStart = 0;
    while (lineStart <= doc.length) {
        const newline = doc.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? doc.length : newline;
        const delimiters: number[] = [];

        for (let pos = lineStart; pos < lineEnd; pos++) {
            const blockRange = blockMathRanges.find(r => pos >= r.from && pos < r.to);
            if (blockRange) {
                pos = blockRange.to - 1;
                continue;
            }
            if (doc[pos] === "$" && (autoClosingDollars.has(pos) || !isDollarEscaped(doc, pos))) {
                delimiters.push(pos);
            }
        }

        // With an odd delimiter count, the line is malformed. Leaving all math
        // on that line visible is safer than guessing and stealing a delimiter
        // from a later formula. A tracked auto-closer makes transient `\` input
        // unambiguous while the user types a LaTeX command.
        if (delimiters.length % 2 === 0) {
            for (let delimiter = 0; delimiter < delimiters.length; delimiter += 2) {
                const from = delimiters[delimiter];
                const end = delimiters[delimiter + 1];
                ranges.push({
                    from,
                    to: end + 1,
                    text: doc.slice(from + 1, end).trim(),
                    type: "inlineMath"
                });
            }
        }

        if (newline === -1) break;
        lineStart = newline + 1;
    }

    const inlineMathRanges = ranges.filter(r => r.type === "inlineMath");
    const mathRangeAt = (pos: number) => inlineMathRanges.find(r => pos >= r.from && pos < r.to);
    const scanDelimitedFormatting = (marker: "*" | "**", type: "italic" | "bold") => {
        for (let start = 0; start <= doc.length - marker.length; start++) {
            if (!doc.startsWith(marker, start) || doc[start - 1] === "\\" || mathRangeAt(start)) continue;
            if (marker === "*" && (doc[start - 1] === "*" || doc[start + 1] === "*")) continue;
            if (marker === "**" && (doc[start - 1] === "*" || doc[start + 2] === "*")) continue;
            if (/\s/.test(doc[start + marker.length] || "")) continue;

            let closing = -1;
            for (let pos = start + marker.length; pos < doc.length && doc[pos] !== "\n"; pos++) {
                const mathRange = mathRangeAt(pos);
                if (mathRange) {
                    pos = mathRange.to - 1;
                    continue;
                }
                if (!doc.startsWith(marker, pos) || doc[pos - 1] === "\\" || /\s/.test(doc[pos - 1] || "")) continue;
                if (marker === "*" && (doc[pos - 1] === "*" || doc[pos + 1] === "*")) continue;
                if (marker === "**" && (doc[pos - 1] === "*" || doc[pos + 2] === "*")) continue;
                closing = pos;
                break;
            }
            if (closing === -1) continue;

            const end = closing + marker.length;
            const conflictingRange = ranges.some(r => {
                const overlaps = Math.max(start, r.from) < Math.min(end, r.to);
                if (!overlaps) return false;
                return !(r.type === "inlineMath" && start < r.from && end > r.to);
            });
            if (!conflictingRange) {
                ranges.push({ from: start, to: end, text: doc.slice(start + marker.length, closing), type });
                start = end - 1;
            }
        }
    };
    scanDelimitedFormatting("**", "bold");
    scanDelimitedFormatting("*", "italic");

    const markdownLinkRegex = /\[([^\]\n]+)\]\((https?:\/\/[^\s)\]">]+)\)/g;
    let match;
    while ((match = markdownLinkRegex.exec(doc)) !== null) {
        const labelFrom = match.index + 1;
        const labelTo = labelFrom + match[1].length;
        ranges.push({
            from: match.index,
            to: match.index + match[0].length,
            text: match[1],
            type: "link",
            url: match[2],
            labelFrom,
            labelTo
        });
    }
    const isWordCharacter = (value: string | undefined) => value !== undefined && /[\p{L}\p{N}]/u.test(value);
    const isOpeningUnderline = (pos: number) =>
        doc[pos] === "_" &&
        doc[pos - 1] !== "\\" &&
        doc[pos - 1] !== "_" &&
        doc[pos + 1] !== "_" &&
        !isWordCharacter(doc[pos - 1]) &&
        !mathRangeAt(pos);
    const isClosingUnderline = (pos: number) =>
        doc[pos] === "_" &&
        doc[pos - 1] !== "\\" &&
        doc[pos - 1] !== "_" &&
        doc[pos + 1] !== "_" &&
        !/\s/.test(doc[pos - 1] || "") &&
        !isWordCharacter(doc[pos + 1]) &&
        !mathRangeAt(pos);

    for (let start = 0; start < doc.length; start++) {
        if (!isOpeningUnderline(start)) continue;

        let closing = -1;
        for (let pos = start + 1; pos < doc.length && doc[pos] !== "\n"; pos++) {
            const mathRange = mathRangeAt(pos);
            if (mathRange) {
                pos = mathRange.to - 1;
                continue;
            }
            if (isClosingUnderline(pos)) {
                closing = pos;
                break;
            }
        }
        if (closing === -1) continue;

        const end = closing + 1;
        const text = doc.slice(start + 1, closing);
        const conflictingRange = ranges.some(r => {
            const overlaps = Math.max(start, r.from) < Math.min(end, r.to);
            if (!overlaps) return false;

            // Inline math may be nested inside an underline run. Other overlaps,
            // including underline-like underscores inside math, remain excluded.
            const nestedInlineRange =
                (r.type === "inlineMath" || r.type === "italic" || r.type === "bold") &&
                start < r.from && end > r.to;
            return !nestedInlineRange;
        });
        if (!conflictingRange) {
            ranges.push({
                from: start,
                to: end,
                text: text,
                type: "underline"
            });
            start = closing;
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

    const quoteRegex = /^[ \t]*(> )(.*)$/gm;
    while ((match = quoteRegex.exec(doc)) !== null) {
        const start = match.index + match[0].indexOf('> ');
        const end = match.index + match[0].length;
        // Only check if the "> " itself overlaps with something, not the whole line
        const overlapping = ranges.some(r => Math.max(start, r.from) < Math.min(start + 2, r.to));
        if (!overlapping) {
            ranges.push({
                from: start,
                to: end,
                text: match[0].substring(match[0].indexOf('> ')),
                type: "quote"
            });
        }
    }

    ranges.sort((a, b) => a.from - b.from);
    return ranges;
}

export const parsedRangesField = StateField.define<ParsedRange[]>({
    create(state) {
        return parseRanges(state.doc.toString(), state.field(autoClosingDollarField));
    },
    update(value, tr) {
        if (tr.docChanged || tr.effects.some(effect => effect.is(updateAutoClosingDollar))) {
            return parseRanges(tr.state.doc.toString(), tr.state.field(autoClosingDollarField));
        }
        return value;
    }
});

class MathWidget extends WidgetType {
    constructor(
        public text: string,
        public isBlock: boolean,
        public macros: Record<string, string>,
        public isLinked = false,
        public isQuoted = false
    ) {
        super();
    }

    eq(other: MathWidget) {
        return this.text === other.text && 
               this.isBlock === other.isBlock && 
               this.isLinked === other.isLinked &&
               this.isQuoted === other.isQuoted &&
               JSON.stringify(this.macros) === JSON.stringify(other.macros);
    }

    toDOM(view: EditorView) {
        const span = document.createElement(this.isBlock ? "div" : "span");
        const baseClass = this.isBlock
            ? "cm-math-block text-center border border-transparent hover:border-accent/50 hover:bg-accent/5 rounded-lg transition-all"
            : `cm-math-inline${this.isQuoted ? " cm-quote-math" : ""}`;
        span.className = baseClass;
        span.style.cursor = "text";

        const handleFocus = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            const pos = view.posAtDOM(span);
            view.dispatch({
                selection: { anchor: pos },
                effects: setEditorFocus.of(true)
            });
            view.focus();
        };

        if (!this.isLinked) {
            span.addEventListener("mousedown", handleFocus);
            span.addEventListener("touchstart", handleFocus, { passive: false });
        }

        try {
            katex.render(this.text, span, {
                displayMode: this.isBlock,
                throwOnError: true,
                macros: {...this.macros}
            });
        } catch (e: any) {
            span.innerText = this.text;
            span.className = `${baseClass} text-red-500 bg-red-500/10 px-1 rounded`;
            span.title = e.message;
        }
        return span;
    }

    ignoreEvent() {
        return true;
    }
}

class BlockMathEditingPreviewWidget extends WidgetType {
    constructor(public text: string, public macros: Record<string, string>) {
        super();
    }

    eq(other: BlockMathEditingPreviewWidget) {
        return this.text === other.text && JSON.stringify(this.macros) === JSON.stringify(other.macros);
    }

    toDOM() {
        const dom = document.createElement("div");
        const baseClass = "cm-math-block text-center pointer-events-none";
        dom.className = baseClass;
        try {
            katex.render(this.text, dom, {
                displayMode: true,
                throwOnError: true,
                macros: {...this.macros}
            });
        } catch (e: any) {
            dom.innerText = this.text;
            dom.className = `${baseClass} text-red-500 bg-red-500/10 px-1 rounded`;
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
    ignoreEvent() { return true; }
}

function buildLiveDecorations(state: EditorState) {
    const doc = state.doc.toString();
    const macros = state.facet(livePreviewMacros);
    const isFocused = state.field(editorFocusField, false);
    const ranges = state.field(parsedRangesField);
    
    const selection = state.selection.main;
    const decos: {from: number, to: number, deco: Decoration}[] = [];

    for (const r of ranges) {
        let overlapping = false;
        if (isFocused !== false) {
            if (r.type === "quote") {
                overlapping = selection.from <= r.from + 2 && selection.to >= r.from;
            } else {
                overlapping = selection.from <= r.to && selection.to >= r.from;
            }
        }
        
        if (overlapping) {
            let editClass = "cm-math-editing";
            if (r.type === "bold" || r.type === "italic" || r.type === "underline") {
                editClass = "bg-neutral-800/80 text-blue-300 rounded px-1 cm-inclusive";
            } else if (r.type === "list") {
                editClass = "text-blue-400 font-bold";
            } else if (r.type === "quote") {
                editClass = "text-[#CBF0FF] font-bold";
            }
            
            // 1. The outer background wrapping
            decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: editClass, inclusive: true })});

            // 2. Syntax highlighting specifically for math zones
            if (r.type === "blockMath" || r.type === "inlineMath") {
                const mathText = doc.slice(r.from, r.to);
                const tokens: {from: number, to: number, class: string}[] = [];
                
                let m;
                // Comments %
                const commentRegex = /%.*/g;
                while ((m = commentRegex.exec(mathText)) !== null) {
                    tokens.push({ from: m.index, to: m.index + m[0].length, class: "cm-math-comment italic" });
                }

                const inComment = (index: number) => tokens.some(t => t.class.includes('comment') && index >= t.from && index < t.to);

                // Commands \something
                const cmdRegex = /\\[a-zA-Z]+/g;
                while ((m = cmdRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + m[0].length, class: "cm-math-command" });
                }

                // Escaped symbols (\%, \{, \_)
                const escRegex = /\\([{}%$_\\])/g;
                while ((m = escRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 2, class: "cm-math-escaped" });
                }

                // Braces {}
                const braceRegex = /[{}]/g;
                while ((m = braceRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 1, class: "cm-math-brace" });
                }

                // Sub/superscript _ ^
                const scriptRegex = /[_^]/g;
                while ((m = scriptRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 1, class: "cm-math-script" });
                }

                // Alignment &
                const ampRegex = /&/g;
                while ((m = ampRegex.exec(mathText)) !== null) {
                    if (!inComment(m.index)) tokens.push({ from: m.index, to: m.index + 1, class: "cm-math-align" });
                }

                for (const t of tokens) {
                    decos.push({
                        from: r.from + t.from,
                        to: r.from + t.to,
                        deco: Decoration.mark({ class: t.class })
                    });
                }

                // Math Delimiters ($ and \[\])
                if (r.type === "blockMath") {
                    decos.push({ from: r.from, to: r.from + 2, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
                    decos.push({ from: r.to - 2, to: r.to, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
                } else if (r.type === "inlineMath") {
                    decos.push({ from: r.from, to: r.from + 1, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
                    decos.push({ from: r.to - 1, to: r.to, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
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
                decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: "cm-format-bold text-primary" })});
                decos.push({from: r.to - 2, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "italic") {
                decos.push({from: r.from, to: r.from + 1, deco: Decoration.replace({})});
                decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: "cm-format-italic text-primary" })});
                decos.push({from: r.to - 1, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "underline") {
                decos.push({from: r.from, to: r.from + 1, deco: Decoration.replace({})});
                // Include the hidden delimiters so a math widget at either edge
                // stays inside the single shared underline container.
                decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: "cm-underline-run text-primary" })});
                decos.push({from: r.to - 1, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "list") {
                decos.push({from: r.from, to: r.to, deco: Decoration.replace({
                    widget: new ListWidget()
                })});
            } else if (r.type === "quote") {
                decos.push({from: r.from, to: r.from + 2, deco: Decoration.replace({})});
                decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: "cm-quote-run" })});
            } else if (r.type === "link") {
                decos.push({from: r.from, to: r.labelFrom!, deco: Decoration.replace({})});
                decos.push({
                    from: r.from,
                    to: r.to,
                    deco: Decoration.mark({
                        tagName: "a",
                        class: "cm-markdown-link",
                        attributes: { href: r.url!, target: "_blank", rel: "noopener noreferrer" }
                    })
                });
                decos.push({from: r.labelTo!, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "inlineMath" && r.text.trim().length === 0) {
                decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: "cm-math-editing", inclusive: true })});
                decos.push({ from: r.from, to: r.from + 1, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
                decos.push({ from: r.to - 1, to: r.to, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
            } else {
                const isLinked = r.type === "inlineMath" && ranges.some(candidate =>
                    candidate.type === "link" && candidate.labelFrom! <= r.from && candidate.labelTo! >= r.to
                );
                const isQuoted = r.type === "inlineMath" && ranges.some(candidate =>
                    candidate.type === "quote" && candidate.from <= r.from && candidate.to >= r.to
                );
                decos.push({from: r.from, to: r.to, deco: Decoration.replace({
                    widget: new MathWidget(r.text, r.type === "blockMath", macros, isLinked, isQuoted),
                    block: r.type === "blockMath"
                })});
            }
        }
    }

    decos.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        if (a.to !== b.to) return b.to - a.to; // For equal from, put larger 'to' encompassing ranges first
        // If exact same range, editing wrapper should go first
        const aClass = (a.deco.spec as any)?.class || "";
        const bClass = (b.deco.spec as any)?.class || "";
        if (aClass.includes("cm-math-editing")) return -1;
        if (bClass.includes("cm-math-editing")) return 1;
        return 0;
    });
    return Decoration.set(decos.map(d => d.deco.range(d.from, d.to)), true);
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
        if (r.type === "inlineMath" && r.text.trim().length > 0) {
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
