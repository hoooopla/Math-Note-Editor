import { Decoration, DecorationSet, EditorView, WidgetType, showTooltip, Tooltip, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateField, EditorState, Facet, StateEffect } from "@codemirror/state";
import katex from "katex";
import "katex/dist/katex.min.css"; 

export const livePreviewMacros = Facet.define<Record<string, string>, Record<string, string>>({
    combine: values => values[0] || {}
});

export const setEditorFocus = StateEffect.define<boolean>();

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
    type: "blockMath" | "inlineMath" | "bold" | "italic" | "underline" | "list" | "quote";
}

function parseRanges(doc: string): ParsedRange[] {
    const ranges: ParsedRange[] = [];
    
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

        if (doc[i] === '$' && doc[i - 1] !== '\\') {
            let end = doc.indexOf("$", i + 1);
            while (end !== -1 && doc[end - 1] === '\\') {
                end = doc.indexOf("$", end + 1);
            }
            if (end !== -1) {
                const text = doc.slice(i + 1, end).trim();
                ranges.push({
                    from: i, 
                    to: end + 1, 
                    text: text,
                    type: "inlineMath"
                });
                i = end + 1;
                continue;
            }
        }
        i++;
    }

    // Mask math ranges so math internal syntax (like * or _) does not break formatting regexes
    let maskedDoc = doc;
    for (const r of ranges) {
        if (r.type === "blockMath" || r.type === "inlineMath") {
            const len = r.to - r.from;
            maskedDoc = maskedDoc.slice(0, r.from) + "a".repeat(len) + maskedDoc.slice(r.to);
        }
    }

    function isInvalidOverlap(start: number, end: number, r: ParsedRange): boolean {
        const hasIntersection = Math.max(start, r.from) < Math.min(end, r.to);
        if (!hasIntersection) return false;

        // Cannot intersect blockMath
        if (r.type === "blockMath") return true;

        // If r is fully contained within [start, end] (e.g. formatting enclosing math or inner formatting)
        if (start <= r.from && r.to <= end) {
            if (start === r.from && end === r.to && r.type !== "inlineMath") return true;
            return false;
        }

        // If [start, end] is fully contained within r (e.g. inner formatting inside outer formatting)
        if (r.type !== "inlineMath" && r.from <= start && end <= r.to) {
            return false;
        }

        return true;
    }

    const boldRegex = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
    let match;
    while ((match = boldRegex.exec(maskedDoc)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const invalid = ranges.some(r => isInvalidOverlap(start, end, r));
        if (!invalid) {
            ranges.push({
                from: start,
                to: end,
                text: doc.slice(start + 2, end - 2),
                type: "bold"
            });
        }
    }

    const italicRegex = /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g;
    while ((match = italicRegex.exec(maskedDoc)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const text = doc.slice(start + 1, end - 1);
        const invalid = ranges.some(r => isInvalidOverlap(start, end, r));
        if (!invalid) {
            ranges.push({
                from: start,
                to: end,
                text: text,
                type: "italic"
            });
        }
    }

    const underlineRegex = /(?<!_)_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g;
    while ((match = underlineRegex.exec(maskedDoc)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const text = doc.slice(start + 1, end - 1);
        const invalid = ranges.some(r => isInvalidOverlap(start, end, r));
        if (!invalid) {
            ranges.push({
                from: start,
                to: end,
                text: text,
                type: "underline"
            });
        }
    }

    const listRegex = /^[ \t]*(\*)(?=\s)/gm;
    while ((match = listRegex.exec(maskedDoc)) !== null) {
        const start = match.index + match[0].length - 1;
        const end = start + 1;
        const invalid = ranges.some(r => isInvalidOverlap(start, end, r));
        if (!invalid) {
            ranges.push({
                from: start,
                to: end,
                text: "*",
                type: "list"
            });
        }
    }

    const quoteRegex = /^[ \t]*(> )(.*)$/gm;
    while ((match = quoteRegex.exec(maskedDoc)) !== null) {
        const start = match.index + match[0].indexOf('> ');
        const end = match.index + match[0].length;
        // Only check if the "> " itself overlaps with something, not the whole line
        const invalid = ranges.some(r => Math.max(start, r.from) < Math.min(start + 2, r.to));
        if (!invalid) {
            ranges.push({
                from: start,
                to: end,
                text: doc.substring(start + 2),
                type: "quote"
            });
        }
    }

    ranges.sort((a, b) => a.from - b.from || b.to - a.to);
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
    constructor(
        public text: string, 
        public isBlock: boolean, 
        public macros: Record<string, string>,
        public isBold: boolean = false,
        public isItalic: boolean = false,
        public isUnderline: boolean = false,
        public underlineGroupId?: string
    ) {
        super();
    }

    eq(other: MathWidget) {
        return this.text === other.text && 
               this.isBlock === other.isBlock && 
               this.isBold === other.isBold &&
               this.isItalic === other.isItalic &&
               this.isUnderline === other.isUnderline &&
               this.underlineGroupId === other.underlineGroupId &&
               JSON.stringify(this.macros) === JSON.stringify(other.macros);
    }

    toDOM(view: EditorView) {
        const span = document.createElement(this.isBlock ? "div" : "span");
        let baseClass = this.isBlock ? "cm-math-block text-center border border-transparent hover:border-accent/50 hover:bg-accent/5 rounded-lg transition-all" : "cm-math-inline";
        
        if (!this.isBlock) {
            if (this.isBold) baseClass += " font-bold";
            if (this.isItalic) baseClass += " italic";
            if (this.isUnderline) baseClass += " cm-underline-element";
        }

        if (this.underlineGroupId) {
            span.setAttribute("data-u-group", this.underlineGroupId);
        }

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

        span.addEventListener("mousedown", handleFocus);
        span.addEventListener("touchstart", handleFocus, { passive: false });

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
            if (r.type === "bold") {
                editClass = "bg-neutral-800/80 text-blue-300 font-bold rounded px-1 cm-inclusive";
            } else if (r.type === "italic") {
                editClass = "bg-neutral-800/80 text-blue-300 italic rounded px-1 cm-inclusive";
            } else if (r.type === "underline") {
                editClass = "bg-neutral-800/80 text-blue-300 underline underline-offset-2 rounded px-1 cm-inclusive";
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
                decos.push({from: r.from + 2, to: r.to - 2, deco: Decoration.mark({ class: "font-bold text-primary" })});
                decos.push({from: r.to - 2, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "italic") {
                decos.push({from: r.from, to: r.from + 1, deco: Decoration.replace({})});
                decos.push({from: r.from + 1, to: r.to - 1, deco: Decoration.mark({ class: "italic text-primary" })});
                decos.push({from: r.to - 1, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "underline") {
                const groupId = `u-${r.from}-${r.to}`;
                decos.push({from: r.from, to: r.from + 1, deco: Decoration.replace({})});
                decos.push({
                    from: r.from + 1, 
                    to: r.to - 1, 
                    deco: Decoration.mark({ 
                        class: "cm-underline-element text-primary not-italic",
                        attributes: { "data-u-group": groupId }
                    })
                });
                decos.push({from: r.to - 1, to: r.to, deco: Decoration.replace({})});
            } else if (r.type === "list") {
                decos.push({from: r.from, to: r.to, deco: Decoration.replace({
                    widget: new ListWidget()
                })});
            } else if (r.type === "quote") {
                decos.push({from: r.from, to: r.from + 2, deco: Decoration.replace({})});
                if (r.to > r.from + 2) {
                    decos.push({from: r.from + 2, to: r.to, deco: Decoration.mark({ class: "text-[#CBF0FF] font-bold" })});
                }
            } else if (r.type === "inlineMath" && r.text.trim().length === 0) {
                decos.push({from: r.from, to: r.to, deco: Decoration.mark({ class: "cm-math-editing", inclusive: true })});
                decos.push({ from: r.from, to: r.from + 1, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
                decos.push({ from: r.to - 1, to: r.to, deco: Decoration.mark({ class: "cm-math-delimiter" }) });
            } else {
                let isBold = false;
                let isItalic = false;
                let isUnderline = false;
                let underlineGroupId: string | undefined = undefined;

                if (r.type === "inlineMath") {
                    for (const parent of ranges) {
                        if (parent.from <= r.from && parent.to >= r.to) {
                            if (parent.type === "bold") isBold = true;
                            if (parent.type === "italic") isItalic = true;
                            if (parent.type === "underline") {
                                isUnderline = true;
                                underlineGroupId = `u-${parent.from}-${parent.to}`;
                            }
                        }
                    }
                }

                decos.push({from: r.from, to: r.to, deco: Decoration.replace({
                    widget: new MathWidget(r.text, r.type === "blockMath", macros, isBold, isItalic, isUnderline, underlineGroupId),
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

function alignUnderlinesInView(view: EditorView) {
    const allGroupEls = view.dom.querySelectorAll<HTMLElement>('[data-u-group]');
    if (allGroupEls.length === 0) return;

    const uGroupMap = new Map<string, HTMLElement[]>();
    allGroupEls.forEach(el => {
        const gid = el.getAttribute('data-u-group');
        if (gid) {
            if (!uGroupMap.has(gid)) uGroupMap.set(gid, []);
            uGroupMap.get(gid)!.push(el);
        }
    });

    uGroupMap.forEach((els) => {
        if (els.length === 0) return;

        // Reset paddingBottom to 0 to measure natural layout rects
        els.forEach(el => {
            el.style.paddingBottom = '0px';
        });

        // Subdivide into line groups for elements on the same line
        const lineGroups: HTMLElement[][] = [];
        els.forEach(el => {
            const rect = el.getBoundingClientRect();
            let added = false;
            for (const lineGroup of lineGroups) {
                const sampleRect = lineGroup[0].getBoundingClientRect();
                if (Math.abs(rect.top - sampleRect.top) < 8) {
                    lineGroup.push(el);
                    added = true;
                    break;
                }
            }
            if (!added) {
                lineGroups.push([el]);
            }
        });

        for (const lineGroup of lineGroups) {
            let maxBottom = -Infinity;
            const rects = lineGroup.map(el => {
                const rect = el.getBoundingClientRect();
                if (rect.bottom > maxBottom) {
                    maxBottom = rect.bottom;
                }
                return rect;
            });

            lineGroup.forEach((el, i) => {
                const diff = maxBottom - rects[i].bottom;
                if (diff > 0.2) {
                    el.style.paddingBottom = `${diff.toFixed(2)}px`;
                } else {
                    el.style.paddingBottom = '0px';
                }
            });
        }
    });
}

export const underlineAlignPlugin = ViewPlugin.fromClass(
    class {
        private observer: MutationObserver | null = null;
        private resizeObserver: ResizeObserver | null = null;
        private rafId: number | null = null;

        constructor(public view: EditorView) {
            this.scheduleAlign();
            if (typeof MutationObserver !== "undefined") {
                this.observer = new MutationObserver(() => this.scheduleAlign());
                this.observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
            }
            if (typeof ResizeObserver !== "undefined") {
                this.resizeObserver = new ResizeObserver(() => this.scheduleAlign());
                this.resizeObserver.observe(view.dom);
            }
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged || update.geometryChanged) {
                this.scheduleAlign();
            }
        }

        scheduleAlign() {
            if (this.rafId !== null) cancelAnimationFrame(this.rafId);
            this.rafId = requestAnimationFrame(() => {
                this.rafId = null;
                alignUnderlinesInView(this.view);
            });
        }

        destroy() {
            if (this.rafId !== null) cancelAnimationFrame(this.rafId);
            this.observer?.disconnect();
            this.resizeObserver?.disconnect();
        }
    }
);
