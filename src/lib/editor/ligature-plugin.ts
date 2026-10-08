import { Decoration, DecorationSet, MatchDecorator, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { type Range } from "@codemirror/state";
import { parsedRangesField, type ParsedRange } from "./katex-plugin";

const ligatureDecoration = Decoration.mark({
    class: "cm-ligature"
});

const ligatureMatcher = new MatchDecorator({
    regexp: /(~>|<=>|=>|<=)/g,
    decoration: ligatureDecoration
});

function outsideMath(matches: DecorationSet, math: ParsedRange[], docLength: number): DecorationSet {
    const decorations: Range<Decoration>[] = [];
    let mathIndex = 0;
    matches.between(0, docLength, (from, to, decoration) => {
        while (mathIndex < math.length && math[mathIndex].to <= from) mathIndex++;
        if (mathIndex === math.length || math[mathIndex].from >= to) {
            decorations.push(decoration.range(from, to));
        }
    });
    return Decoration.set(decorations);
}

export const ligaturePlugin = ViewPlugin.fromClass(class {
    parsedRanges: ParsedRange[];
    mathRanges: ParsedRange[];
    matches: DecorationSet;
    ligatures: DecorationSet;

    constructor(view: EditorView) {
        this.parsedRanges = view.state.field(parsedRangesField);
        this.mathRanges = this.parsedRanges
            .filter(range => range.type === "inlineMath" || range.type === "blockMath")
            .sort((a, b) => a.from - b.from);
        this.matches = ligatureMatcher.createDeco(view);
        this.ligatures = outsideMath(this.matches, this.mathRanges, view.state.doc.length);
    }

    update(update: ViewUpdate) {
        const matches = ligatureMatcher.updateDeco(update, this.matches);
        const parsedRanges = update.state.field(parsedRangesField);
        const rangesChanged = parsedRanges !== this.parsedRanges;
        if (matches !== this.matches || rangesChanged) {
            this.matches = matches;
            this.parsedRanges = parsedRanges;
            if (rangesChanged) {
                this.mathRanges = parsedRanges
                    .filter(range => range.type === "inlineMath" || range.type === "blockMath")
                    .sort((a, b) => a.from - b.from);
            }
            this.ligatures = outsideMath(this.matches, this.mathRanges, update.state.doc.length);
        }
    }
}, {
    decorations: instance => instance.ligatures
});
