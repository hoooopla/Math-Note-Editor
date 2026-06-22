import { EditorState, Transaction } from "@codemirror/state";
import { parsedRangesField } from "./katex-plugin";

const REPLACEMENTS: Record<string, string> = {
    "teh ": "the ",
    "don;t ": "don't ",
    "-->": "→",
    "->": "→",
    "<-": "←",
    "<--": "←",
    "(c)": "©",
    "(r)": "®",
    "(tm)": "™",
    "!=": "≠",
    "+-": "±",
    ":-)": "🙂",
    ":)": "🙂",
    ":-(": "☹️",
    ":(": "☹️",
    ":-D": "😀",
    ":D": "😀",
};

export const autoReplaceFilter = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(Transaction.userEvent) !== "input.type") return tr;

    let additionalChanges: Array<{from: number, to: number, insert: string}> = [];
    
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const ranges = tr.startState.field(parsedRangesField, false);
        if (ranges) {
            const inMath = ranges.some(r => 
                (r.type === "inlineMath" || r.type === "blockMath") && 
                fromA >= r.from && toA <= r.to
            );
            if (inMath) return; // Skip in math or code
        }

        const newDoc = tr.newDoc;
        const pos = toB;

        for (const [key, value] of Object.entries(REPLACEMENTS)) {
            if (pos >= key.length) {
                const suffix = newDoc.sliceString(pos - key.length, pos);
                if (suffix === key) {
                    additionalChanges.push({
                        from: pos - key.length,
                        to: pos,
                        insert: value
                    });
                    break;
                }
            }
        }
    });

    if (additionalChanges.length > 0) {
        return [tr, { changes: additionalChanges, sequential: true }];
    }

    return tr;
});
