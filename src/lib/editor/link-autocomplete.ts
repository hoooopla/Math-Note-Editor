import { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { Transaction } from "@codemirror/state";
import { useStore } from "../../store";
import { parentLabelFacet } from "./embedded-block-plugin";

export function linkCompletion(context: CompletionContext): CompletionResult | null {
    // Match anything after `[[` until the cursor (and only if we are typing inside `[[ ... `)
    const beforeRegex = /\[\[([^\]]*)$/;
    const beforeStr = context.state.doc.sliceString(Math.max(0, context.pos - 100), context.pos);
    const beforeMatch = beforeStr.match(beforeRegex);
    if (!beforeMatch) return null;

    const textBeforeCursor = beforeMatch[1];
    
    // If the cursor is past `||`, we are typing the alias formatting, so no block autocomplete
    if (textBeforeCursor.includes("||")) {
        return null;
    }

    const afterRegex = /^([^\]]*)/;
    const afterStr = context.state.doc.sliceString(context.pos, Math.min(context.pos + 100, context.state.doc.length));
    const afterMatch = afterStr.match(afterRegex);
    const textAfterCursor = afterMatch ? afterMatch[1] : "";

    // The alias divider might be in the text after the cursor
    const pipeIdxAfter = textAfterCursor.indexOf("||");
    const labelAfterCursor = pipeIdxAfter !== -1 ? textAfterCursor.slice(0, pipeIdxAfter) : textAfterCursor;

    let queryLabel = textBeforeCursor + labelAfterCursor;
    const from = context.pos - textBeforeCursor.length;
    const to = context.pos + labelAfterCursor.length;

    const hasAt = queryLabel.startsWith("@");
    if (hasAt) {
        queryLabel = queryLabel.slice(1);
    }
    
    const store = useStore.getState();
    const blocks = store.blocks;
    const parentLabel = context.state.facet(parentLabelFacet);
    
    const options: Completion[] = [];

    const isRelative = queryLabel.startsWith("/");
    const fullQueryLabel = isRelative ? parentLabel + queryLabel : queryLabel;
    
    const exactMatch = blocks.some(b => b.label === fullQueryLabel);
    if (queryLabel.trim().length > 0 && queryLabel !== "/" && !exactMatch) {
        let applyText = queryLabel;
        if (hasAt) applyText = "@" + applyText;

        options.push({
            label: applyText,
            displayLabel: `Create new block: "${queryLabel}"`,
            detail: "create",
            type: "create",
            boost: 998,
            apply: (view, completion, applyFrom, applyTo) => {
                view.dispatch({
                    changes: { from: applyFrom, to: applyTo, insert: applyText },
                    annotations: Transaction.userEvent.of("input.complete")
                });
                const newTitle = fullQueryLabel.includes("/") ? fullQueryLabel.slice(fullQueryLabel.lastIndexOf("/") + 1) : fullQueryLabel;
                store.addBlock(undefined, { title: newTitle, label: fullQueryLabel });
            }
        });
    }

    for (const b of blocks) {
        // filter blocks so we only suggest ones matching query
        if (queryLabel && !b.label.toLowerCase().includes(fullQueryLabel.toLowerCase()) && !b.title.toLowerCase().includes(queryLabel.toLowerCase())) {
            continue;
        }

        let applyText = b.label;
        if (hasAt) {
            applyText = "@" + applyText;
        }

        options.push({
            label: applyText, // `label` is the primary searchable string and default insertion text
            displayLabel: b.label,
            detail: b.title && b.title !== b.label ? b.title : "",
            type: "text",
            apply: (view, completion, applyFrom, applyTo) => {
                view.dispatch({
                    changes: { from: applyFrom, to: applyTo, insert: applyText },
                    annotations: Transaction.userEvent.of("input.complete")
                });
            }
        });

        // "account for relative path"
        if (parentLabel && b.label.startsWith(parentLabel + "/")) {
            const relText = b.label.slice(parentLabel.length); // starts with "/"
            if (!queryLabel || relText.toLowerCase().includes(queryLabel.toLowerCase()) || b.title.toLowerCase().includes(queryLabel.toLowerCase())) {
                let applyRelText = relText;
                if (hasAt) {
                    applyRelText = "@" + applyRelText;
                }
                
                options.push({
                    label: applyRelText,
                    displayLabel: relText,
                    detail: b.title && b.title !== b.label ? b.title : "",
                    type: "text",
                    apply: (view, completion, applyFrom, applyTo) => {
                        view.dispatch({
                            changes: { from: applyFrom, to: applyTo, insert: applyRelText },
                            annotations: Transaction.userEvent.of("input.complete")
                        });
                    }
                });
            }
        }
    }

    // Make sure we apply based on the calculated full range inside brackets
    return {
        from: from,
        to: to,
        options: options,
        filter: false,
        update: (current: CompletionResult, from: number, to: number, context: CompletionContext) => {
            return linkCompletion(context);
        }
    };
}
