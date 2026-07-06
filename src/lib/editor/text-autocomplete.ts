import { CompletionContext } from "@codemirror/autocomplete";
import { Transaction } from "@codemirror/state";
import { useStore } from "../../store";
import { parsedRangesField } from "./katex-plugin";

export function textCompletion(context: CompletionContext) {
    const ranges = context.state.field(parsedRangesField, false);
    if (ranges) {
        // If we are INSIDE a math block, don't trigger text completion
        const isInMath = ranges.some(r => (r.type === "inlineMath" || r.type === "blockMath") && context.pos >= r.from && context.pos <= r.to);
        if (isInMath) return null;
    }

    const word = context.matchBefore(/\\[a-zA-Z]*$/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const afterStr = context.state.doc.sliceString(context.pos, Math.min(context.pos + 50, context.state.doc.length));
    const wordAfterMatch = afterStr.match(/^[a-zA-Z]*/);
    const to = context.pos + (wordAfterMatch ? wordAfterMatch[0].length : 0);

    const settings = useStore.getState().settings;
    const textCommands = settings.textCommands || [];
    if (textCommands.length === 0) return null;

    const options = textCommands.map((cmd, idx) => {
        const text = cmd.startsWith('\\') ? cmd.slice(1) : cmd;
        return {
            label: `\\${text}`,
            displayLabel: text,
            apply: (view: any, completion: any, applyFrom: number, applyTo: number) => {
                view.dispatch({
                    changes: { from: applyFrom, to: applyTo, insert: text },
                    annotations: Transaction.userEvent.of("input.complete")
                });
            },
            detail: "text",
            type: "keyword",
            boost: -idx // keep the settings order
        };
    });

    return {
        from: word.from,
        to: to,
        options: options,
        validFor: /^\\[a-zA-Z]*$/
    };
}
