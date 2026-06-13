import { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { useStore } from "../../store";
import { parentLabelFacet } from "./embedded-block-plugin";

export function linkCompletion(context: CompletionContext): CompletionResult | null {
    // Match anything after `[[` until the cursor (and only if we are typing inside `[[ ... `)
    const match = context.matchBefore(/\[\[[^\]]*/);
    if (!match) return null;

    let rawQuery = match.text.slice(2);
    const hasAt = rawQuery.startsWith("@");
    if (hasAt) {
        rawQuery = rawQuery.slice(1);
    }
    
    // If there is a `||`, cursor might be typing title, we can still autocomplete the whole block but 
    // maybe we shouldn't trigger if they are past the `||`? 
    // Let's just use the label part for matching
    const pipeIdx = rawQuery.indexOf("||");
    const queryLabel = pipeIdx !== -1 ? rawQuery.slice(0, pipeIdx) : rawQuery;

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
            apply: (view, completion, from, to) => {
                view.dispatch({
                    changes: { from, to, insert: applyText },
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
            apply: applyText
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
                    apply: applyRelText
                });
            }
        }
    }

    return {
        from: match.from + 2,
        options: options,
        validFor: /^[^\]]*$/
    };
}
