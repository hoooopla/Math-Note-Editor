import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, showTooltip, Tooltip } from "@codemirror/view";
import { RangeSetBuilder, StateField, EditorState, Facet, StateEffect, Transaction } from "@codemirror/state";
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
                // Empty pairs still establish math context for subsequent typing.
                ranges.push({ from: i, to: end + 2, text, type: "blockMath" });
                i = end + 2;
                continue;
            }
        }
        i++;
    }

    const blockMathRanges = ranges.filter(r => r.type === "blockMath");
    const rangeAt = (candidates: ParsedRange[], pos: number) => {
        let low = 0;
        let high = candidates.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const candidate = candidates[middle];
            if (pos < candidate.from) high = middle - 1;
            else if (pos >= candidate.to) low = middle + 1;
            else return candidate;
        }
        return undefined;
    };
    let lineStart = 0;
    while (lineStart <= doc.length) {
        const newline = doc.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? doc.length : newline;
        const delimiters: number[] = [];

        for (let pos = lineStart; pos < lineEnd; pos++) {
            const blockRange = rangeAt(blockMathRanges, pos);
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
    const mathRangeAt = (pos: number) => rangeAt(inlineMathRanges, pos);
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

type ChangedRegion = { from: number; to: number };

// Only \[ and \] delimit display math in this editor. Adjacent dollars are
// deliberately parsed as an empty inline-math pair, so typing $$ within a line
// never expands incremental reparsing to the full document.
function containsBlockMathDelimiter(text: string) {
    return /\\\[|\\\]/.test(text);
}

function mergeRegions(regions: ChangedRegion[]) {
    const sorted = regions.sort((a, b) => a.from - b.from);
    return sorted.reduce<ChangedRegion[]>((merged, region) => {
        const previous = merged[merged.length - 1];
        if (previous && region.from <= previous.to + 1) previous.to = Math.max(previous.to, region.to);
        else merged.push({ ...region });
        return merged;
    }, []);
}

function updateParsedRanges(value: ParsedRange[], tr: Transaction): ParsedRange[] {
    const oldRegions: ChangedRegion[] = [];
    const newRegions: ChangedRegion[] = [];
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        const oldStart = tr.startState.doc.lineAt(fromA);
        const oldEnd = tr.startState.doc.lineAt(Math.min(tr.startState.doc.length, toA));
        const newStart = tr.state.doc.lineAt(fromB);
        const newEnd = tr.state.doc.lineAt(Math.min(tr.state.doc.length, toB));
        oldRegions.push({ from: oldStart.from, to: oldEnd.to });
        newRegions.push({ from: newStart.from, to: newEnd.to });
    });

    const overlaps = (range: ChangedRegion, region: ChangedRegion) => range.from <= region.to && range.to >= region.from;

    // Delimiter edits can change pairing across the document. Ordinary edits
    // inside an existing display formula only need its complete source range.
    const touchesBlockDelimiter = oldRegions.some(region => containsBlockMathDelimiter(tr.startState.doc.sliceString(region.from, region.to))) ||
        newRegions.some(region => containsBlockMathDelimiter(tr.state.doc.sliceString(region.from, region.to)));
    if (touchesBlockDelimiter) {
        return parseRanges(tr.state.doc.toString(), tr.state.field(autoClosingDollarField));
    }
    // Expand transitively: another formula may share the boundary line.
    const included = new Set<ParsedRange>();
    let expanded = true;
    while (expanded) {
        expanded = false;
        for (const range of value) {
            if (range.type !== "blockMath" || included.has(range) || !oldRegions.some(region => overlaps(range, region))) continue;
            included.add(range);
            const from = tr.startState.doc.lineAt(range.from).from;
            const to = tr.startState.doc.lineAt(range.to).to;
            oldRegions.push({ from, to });
            newRegions.push({
                from: tr.state.doc.lineAt(tr.changes.mapPos(from, -1)).from,
                to: tr.state.doc.lineAt(tr.changes.mapPos(to, 1)).to
            });
            expanded = true;
        }
    }
    const mergedOld = mergeRegions(oldRegions);
    const mergedNew = mergeRegions(newRegions);

    const mapped = value
        .filter(range => !mergedOld.some(region => overlaps(range, region)))
        .map(range => ({
            ...range,
            from: tr.changes.mapPos(range.from, 1),
            to: tr.changes.mapPos(range.to, -1),
            ...(range.labelFrom !== undefined ? { labelFrom: tr.changes.mapPos(range.labelFrom, 1) } : {}),
            ...(range.labelTo !== undefined ? { labelTo: tr.changes.mapPos(range.labelTo, -1) } : {})
        }));

    const autoClosers = tr.state.field(autoClosingDollarField);
    for (const region of mergedNew) {
        const localAutoClosers = new Set<number>();
        for (const pos of autoClosers) {
            if (pos >= region.from && pos <= region.to) localAutoClosers.add(pos - region.from);
        }
        const parsed = parseRanges(tr.state.doc.sliceString(region.from, region.to), localAutoClosers);
        for (const range of parsed) {
            mapped.push({
                ...range,
                from: range.from + region.from,
                to: range.to + region.from,
                ...(range.labelFrom !== undefined ? { labelFrom: range.labelFrom + region.from } : {}),
                ...(range.labelTo !== undefined ? { labelTo: range.labelTo + region.from } : {})
            });
        }
    }
    mapped.sort((a, b) => a.from - b.from || a.to - b.to);
    return mapped;
}

export const parsedRangesField = StateField.define<ParsedRange[]>({
    create(state) {
        return parseRanges(state.doc.toString(), state.field(autoClosingDollarField));
    },
    update(value, tr) {
        if (tr.docChanged) {
            return updateParsedRanges(value, tr);
        }
        if (tr.effects.some(effect => effect.is(updateAutoClosingDollar))) {
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
            ? "cm-math-block cm-math-rendered text-center border border-transparent hover:border-accent/50 hover:bg-accent/5 rounded-lg transition-all"
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

// Keep preview DOM stable during typing and render only the latest formula.
const previewControllers = new WeakMap<HTMLElement, ReturnType<typeof mathPreview>>();
function mathPreview(dom: HTMLElement, view: EditorView, displayMode: boolean, baseClass: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let text: string | undefined;
    let macrosKey = "";
    let destroyed = false;
    return {
        update(nextText: string, macros: Record<string, string>, immediate = false) {
            const nextKey = JSON.stringify(macros);
            if (text === nextText && macrosKey === nextKey) return;
            text = nextText;
            macrosKey = nextKey;
            clearTimeout(timer);
            const render = () => {
                if (destroyed) return;
                try {
                    katex.render(nextText, dom, { displayMode, throwOnError: true, macros: { ...macros } });
                    dom.className = baseClass;
                } catch {
                    dom.textContent = nextText;
                    dom.className = `${baseClass} text-red-500 bg-red-500/10 font-mono text-sm`;
                }
                view.requestMeasure();
            };
            if (immediate) render();
            else timer = setTimeout(render, 70);
        },
        destroy() {
            destroyed = true;
            clearTimeout(timer);
        }
    };
}

class BlockMathEditingPreviewWidget extends WidgetType {
    constructor(public text: string, public macros: Record<string, string>) { super(); }

    eq(other: BlockMathEditingPreviewWidget) {
        return this.text === other.text && JSON.stringify(this.macros) === JSON.stringify(other.macros);
    }

    toDOM(view: EditorView) {
        const dom = document.createElement("div");
        const controller = mathPreview(dom, view, true, "cm-math-block text-center pointer-events-none");
        previewControllers.set(dom, controller);
        controller.update(this.text, this.macros, true);
        return dom;
    }

    updateDOM(dom: HTMLElement) {
        const controller = previewControllers.get(dom);
        if (!controller) return false;
        controller.update(this.text, this.macros);
        return true;
    }

    destroy(dom: HTMLElement) {
        previewControllers.get(dom)?.destroy();
        previewControllers.delete(dom);
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

type DecorationEntry = { from: number; to: number; deco: Decoration };

function appendMathSyntaxDecorations(doc: string, range: ParsedRange, decos: DecorationEntry[]) {
    const mathText = doc.slice(range.from, range.to);
    const tokens: { from: number; to: number; class: string }[] = [];

    let match;
    const commentRegex = /%.*/g;
    while ((match = commentRegex.exec(mathText)) !== null) {
        tokens.push({ from: match.index, to: match.index + match[0].length, class: "cm-math-comment italic" });
    }

    const inComment = (index: number) => tokens.some(token =>
        token.class.includes("comment") && index >= token.from && index < token.to
    );

    const tokenPatterns: Array<[RegExp, string]> = [
        [/\\[a-zA-Z]+/g, "cm-math-command"],
        [/\\([{}%$_\\])/g, "cm-math-escaped"],
        [/[{}]/g, "cm-math-brace"],
        [/[_^]/g, "cm-math-script"],
        [/&/g, "cm-math-align"]
    ];
    for (const [pattern, className] of tokenPatterns) {
        while ((match = pattern.exec(mathText)) !== null) {
            if (!inComment(match.index)) {
                tokens.push({ from: match.index, to: match.index + match[0].length, class: className });
            }
        }
    }

    for (const token of tokens) {
        decos.push({
            from: range.from + token.from,
            to: range.from + token.to,
            deco: Decoration.mark({ class: token.class })
        });
    }

    const delimiterLength = range.type === "blockMath" ? 2 : 1;
    decos.push({
        from: range.from,
        to: range.from + delimiterLength,
        deco: Decoration.mark({ class: "cm-math-delimiter" })
    });
    decos.push({
        from: range.to - delimiterLength,
        to: range.to,
        deco: Decoration.mark({ class: "cm-math-delimiter" })
    });
}

function decorationSet(entries: DecorationEntry[]) {
    entries.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        if (a.to !== b.to) return b.to - a.to;
        const aClass = (a.deco.spec as any)?.class || "";
        const bClass = (b.deco.spec as any)?.class || "";
        if (aClass.includes("cm-math-editing")) return -1;
        if (bClass.includes("cm-math-editing")) return 1;
        return 0;
    });
    return Decoration.set(entries.map(entry => entry.deco.range(entry.from, entry.to)), true);
}

function buildBlockMathDecorations(state: EditorState) {
    const doc = state.doc.toString();
    const macros = state.facet(livePreviewMacros);
    const isFocused = state.field(editorFocusField, false);
    const selection = state.selection.main;
    const decos: DecorationEntry[] = [];

    for (const range of state.field(parsedRangesField).filter(range => range.type === "blockMath")) {
        const overlapping = isFocused !== false && selection.from <= range.to && selection.to >= range.from;
        if (overlapping || !range.text) {
            decos.push({
                from: range.from,
                to: range.to,
                deco: Decoration.mark({ class: "cm-math-editing", inclusive: true })
            });
            appendMathSyntaxDecorations(doc, range, decos);
            if (range.text) decos.push({
                from: range.to,
                to: range.to,
                deco: Decoration.widget({
                    widget: new BlockMathEditingPreviewWidget(range.text, macros),
                    block: true,
                    side: 1
                })
            });
        } else {
            decos.push({
                from: range.from,
                to: range.to,
                deco: Decoration.replace({
                    widget: new MathWidget(range.text, true, macros),
                    block: true
                })
            });
        }
    }

    return decorationSet(decos);
}

export const blockMathDecorationField = StateField.define<DecorationSet>({
    create: buildBlockMathDecorations,
    update(value, transaction) {
        const before = transaction.startState;
        const after = transaction.state;
        if (before.field(parsedRangesField) === after.field(parsedRangesField) &&
            before.selection.eq(after.selection) &&
            before.field(editorFocusField) === after.field(editorFocusField) &&
            before.facet(livePreviewMacros) === after.facet(livePreviewMacros)) return value;
        return buildBlockMathDecorations(after);
    },
    provide: field => EditorView.decorations.from(field)
});

function buildLiveDecorations(view: EditorView) {
    const state = view.state;
    const doc = state.doc.toString();
    const macros = state.facet(livePreviewMacros);
    const isFocused = state.field(editorFocusField, false);
    const ranges = state.field(parsedRangesField);
    
    const selection = state.selection.main;
    const decos: DecorationEntry[] = [];

    for (const r of ranges) {
        // CodeMirror only permits block decorations from a StateField. Display
        // math is handled by blockMathDecorationField below; this ViewPlugin
        // remains viewport-aware for inline decorations.
        if (r.type === "blockMath") continue;
        const isVisible = view.visibleRanges.some(visible => r.from <= visible.to && r.to >= visible.from);
        const containsSelection = selection.from <= r.to && selection.to >= r.from;
        if (!isVisible && !containsSelection) continue;

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
            if (r.type === "inlineMath") appendMathSyntaxDecorations(doc, r, decos);

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
                    widget: new MathWidget(r.text, false, macros, isLinked, isQuoted)
                })});
            }
        }
    }

    return decorationSet(decos);
}

export const mathPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = buildLiveDecorations(view);
    }

    update(update: ViewUpdate) {
        const macrosChanged = update.state.facet(livePreviewMacros) !== update.startState.facet(livePreviewMacros);
        const focusChanged = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setEditorFocus)));
        if (update.docChanged || update.selectionSet || update.viewportChanged || macrosChanged || focusChanged) {
            this.decorations = buildLiveDecorations(update.view);
        }
    }
}, {
    decorations: plugin => plugin.decorations
});

function activeInlineMath(state: EditorState) {
    if (!state.field(editorFocusField, false)) return undefined;
    const selection = state.selection.main;
    return state.field(parsedRangesField).find(range =>
        range.type === "inlineMath" && range.text.length > 0 &&
        selection.from <= range.to && selection.to >= range.from);
}

// CodeMirror uses the factory identity to retain a tooltip across transactions.
const createMathTooltip: Tooltip["create"] = view => {
    const dom = document.createElement("div");
    const controller = mathPreview(dom, view, false,
        "cm-math-preview p-3 bg-surface border border-outline shadow-lg rounded-xl text-primary z-50 pointer-events-none mb-3 max-w-[90vw]");
    const range = activeInlineMath(view.state);
    if (range) controller.update(range.text, view.state.facet(livePreviewMacros), true);
    return {
        dom,
        update(update) {
            const range = activeInlineMath(update.state);
            if (range) controller.update(range.text, update.state.facet(livePreviewMacros));
        },
        destroy() { controller.destroy(); }
    };
};

export const mathTooltipField = showTooltip.compute(
    ["doc", "selection", editorFocusField, parsedRangesField, livePreviewMacros],
    (state): Tooltip | null => {
        const range = activeInlineMath(state);
        return range ? { pos: range.from, above: true, create: createMathTooltip } : null;
    }
);
