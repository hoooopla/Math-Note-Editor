import { CompletionContext, CompletionResult, Completion, closeCompletion } from "@codemirror/autocomplete";
import { Transaction } from "@codemirror/state";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useStore } from "../../store";
import { MathTitle } from "../../components/MathTitle";
import { parentLabelFacet } from "./embedded-block-plugin";
import { encodeEmbeddedLabel, findActiveEmbeddedTarget } from "../embedded-link-syntax";
import { normalizeBlockLabel, validateBlockMetadata } from "../label-policy";
import { splitPath } from "../utils/path";

function distinguishingPath(label: string, suffixCounts: Map<string, number>): string {
    const segments = splitPath(label);
    let count = 1;
    while (count < segments.length && (suffixCounts.get(JSON.stringify(segments.slice(-count))) || 0) > 1) count++;
    const suffix = segments.slice(-count).join(" › ");
    return count < segments.length ? `… › ${suffix}` : suffix;
}

function completionPreview(fullLabel: string, title: string, insertedText: string) {
    const preview = document.createElement("div");
    preview.className = "cm-link-completion-preview";
    let titleHost: HTMLElement | null = null;
    for (const [caption, value] of [["Title", title], ["Full label", fullLabel], ["Target to insert", insertedText]]) {
        const row = document.createElement("div");
        row.className = "cm-link-completion-preview-row";
        const heading = document.createElement("span");
        heading.className = "cm-link-completion-preview-caption";
        heading.textContent = `${caption}:`;
        const text = document.createElement("span");
        text.className = "cm-link-completion-preview-value";
        if (caption === "Title") {
            text.classList.add("cm-link-completion-preview-title");
            titleHost = text;
        } else {
            text.textContent = value;
        }
        row.append(heading, text);
        preview.appendChild(row);
    }
    const root = createRoot(titleHost!);
    // CM6 measures and positions the info pane as soon as it is attached.
    // Render the math title before that measurement so its height is included.
    flushSync(() => root.render(createElement(MathTitle, { text: title })));
    return { dom: preview, destroy: () => root.unmount() };
}

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
            type: "link-create",
            boost: 998,
            info: () => completionPreview(normalizedCreateLabel, newTitle, applyText),
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

    const matches = store.blockOrder.flatMap(id => {
        const block = store.blocksById[id];
        if (!block) return [];
        const relativeText = parentLabel && block.label.startsWith(parentLabel + "/")
            ? block.label.slice(parentLabel.length) : null;
        if (isRelative && !relativeText) return [];
        const searchableLabel = isRelative ? relativeText! : block.label;
        if (queryLabel && !searchableLabel.toLowerCase().includes(queryLabel.toLowerCase()) &&
            !block.title.toLowerCase().includes(queryLabel.toLowerCase())) return [];
        return [{ block, relativeText }];
    });
    const suffixCounts = new Map<string, number>();
    for (const { block } of matches) {
        const segments = splitPath(block.label);
        for (let count = 1; count <= segments.length; count++) {
            const key = JSON.stringify(segments.slice(-count));
            suffixCounts.set(key, (suffixCounts.get(key) || 0) + 1);
        }
    }
    for (const { block, relativeText } of matches) {
        const applyText = isRelative
            ? encodeEmbeddedLabel(relativeText!, { relative: true })
            : encodeEmbeddedLabel(block.label);
        options.push({
            label: applyText,
            displayLabel: `${isRelative ? "relative · " : ""}${distinguishingPath(block.label, suffixCounts)}`,
            detail: block.title && block.title !== block.label ? block.title : "",
            type: "link",
            info: () => completionPreview(block.label, block.title, applyText),
            apply: (view, completion, applyFrom, applyTo) => {
                view.dispatch({
                    changes: { from: applyFrom, to: applyTo, insert: applyText },
                    annotations: Transaction.userEvent.of("input.complete")
                });
            }
        });
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
