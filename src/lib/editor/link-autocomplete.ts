import { CompletionContext, CompletionResult, Completion, closeCompletion } from "@codemirror/autocomplete";
import { Transaction } from "@codemirror/state";
import { useStore } from "../../store";
import { parentLabelFacet } from "./embedded-block-plugin";
import { encodeEmbeddedLabel, findActiveEmbeddedTarget } from "../embedded-link-syntax";
import { normalizeBlockLabel, validateBlockMetadata } from "../label-policy";
import { splitPath } from "../utils/path";

export function linkCompletion(context: CompletionContext): CompletionResult | null {
    const activeTarget = findActiveEmbeddedTarget(context.state.doc.toString(), context.pos, { allowUnclosed: false });
    if (!activeTarget) return null;

    const queryLabel = activeTarget.label;
    const from = activeTarget.from;
    const to = activeTarget.to;
    
    const store = useStore.getState();
    const parentLabel = context.state.facet(parentLabelFacet);
    
    const options: Completion[] = [];

    const isRelative = activeTarget.relative;
    const fullQueryLabel = isRelative ? parentLabel + queryLabel : queryLabel;
    
    const exactMatch = !!store.blockIdByLabel[fullQueryLabel];
    const normalizedCreateLabel = normalizeBlockLabel(fullQueryLabel);
    const relativeTitle = splitPath(normalizedCreateLabel)
        .map(segment => segment.trim())
        .filter(Boolean)
        .at(-1);
    // An absolute label is the name the user explicitly entered, so mirror
    // search creation and retain it as the initial title. Only relative syntax
    // intentionally supplies parent-path context that should be omitted.
    const newTitle = isRelative ? (relativeTitle || normalizedCreateLabel) : normalizedCreateLabel;
    if (queryLabel.trim().length > 0 && queryLabel !== "/" && !exactMatch && !validateBlockMetadata(newTitle, normalizedCreateLabel)) {
        const applyText = encodeEmbeddedLabel(queryLabel, { relative: isRelative });

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
                void store.addBlock({ title: newTitle, label: normalizedCreateLabel }).then(created => {
                    if (!created || !view.dom.isConnected) return;
                    view.focus();
                    closeCompletion(view);
                    // The block index changed outside CodeMirror. Re-dispatch
                    // the retained caret so the embedded-link tooltip can now
                    // recognize the target as existing.
                    view.dispatch({ selection: view.state.selection });
                });
            }
        });
    }

    for (const id of store.blockOrder) {
        const b = store.blocksById[id];
        if (!b) continue;
        // filter blocks so we only suggest ones matching query
        if (queryLabel && !b.label.toLowerCase().includes(fullQueryLabel.toLowerCase()) && !b.title.toLowerCase().includes(queryLabel.toLowerCase())) {
            continue;
        }

        const applyText = encodeEmbeddedLabel(b.label);

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
                const applyRelText = encodeEmbeddedLabel(relText, { relative: true });
                
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
    const sourceDocument = context.state.doc;
    return {
        from: from,
        to: to,
        options: options,
        filter: false,
        update: (current: CompletionResult, from: number, to: number, context: CompletionContext) => {
            // Cursor-only movement keeps the same immutable document object.
            // Reuse the exact result so CodeMirror does not put the menu into
            // a pending/rebuild cycle (the visible Left/Right flicker).
            if (context.state.doc === sourceDocument) return current;
            return linkCompletion(context);
        }
    };
}
