import { encodeEmbeddedLabel, parseEmbeddedLinks, targetBounds } from "./embedded-link-syntax";
import { validateBlockLabel } from "./label-policy";
import { splitPath } from "./utils/path";

export type RelabelChangeType =
    | "no-op"
    | "rename-node"
    | "insert-parent"
    | "remove-parent"
    | "move-subtree"
    | "move-and-rename";

export interface RelabelBlockInput {
    id: string;
    title: string;
    label: string;
    content?: string;
}

export interface RelabelBlockChange {
    id: string;
    title: string;
    oldLabel: string;
    newLabel: string;
    fileName?: string;
}

export interface RelabelReferenceImpact {
    blockId: string;
    blockTitle: string;
    sourceLabel: string;
    from: number;
    to: number;
    line: number;
    column: number;
    contextBefore: string;
    contextAfter: string;
    oldText: string;
    newText: string;
    oldTarget: string;
    newTarget: string;
    changed: boolean;
    relative: boolean;
    targetExists: boolean;
    fileName?: string;
}

export interface SafeRelabelPlan {
    oldPrefix: string;
    newPrefix: string;
    changeType: RelabelChangeType;
    blockChanges: RelabelBlockChange[];
    referenceImpacts: RelabelReferenceImpact[];
    conflicts: string[];
    warnings: string[];
    revision?: string;
    signature?: string;
}

export function relabelPlanSignatureInput(plan: SafeRelabelPlan): string {
    const blockChanges = plan.blockChanges
        .map(change => [change.id, change.oldLabel, change.newLabel])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const referenceImpacts = plan.referenceImpacts
        .map(impact => [
            impact.blockId,
            impact.from,
            impact.to,
            impact.oldText,
            impact.newText,
            impact.oldTarget,
            impact.newTarget,
            impact.changed
        ])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify({
        oldPrefix: plan.oldPrefix,
        newPrefix: plan.newPrefix,
        changeType: plan.changeType,
        blockChanges,
        referenceImpacts,
        conflicts: [...plan.conflicts].sort()
    });
}

const partsEqual = (left: string[], right: string[]) =>
    left.length === right.length && left.every((part, index) => part === right[index]);

const hasPathPrefix = (label: string, prefix: string) => {
    const labelParts = splitPath(label);
    const prefixParts = splitPath(prefix);
    return labelParts.length >= prefixParts.length
        && prefixParts.every((part, index) => labelParts[index] === part);
};

const replacePathPrefix = (label: string, oldPrefix: string, newPrefix: string) => {
    if (!hasPathPrefix(label, oldPrefix)) return label;
    return [...splitPath(newPrefix), ...splitPath(label).slice(splitPath(oldPrefix).length)].join("/");
};

const isStrictDescendant = (label: string, parent: string) => {
    const labelParts = splitPath(label);
    const parentParts = splitPath(parent);
    return labelParts.length > parentParts.length
        && parentParts.every((part, index) => labelParts[index] === part);
};

export function classifyRelabel(oldPrefix: string, newPrefix: string): RelabelChangeType {
    const oldParts = splitPath(oldPrefix);
    const newParts = splitPath(newPrefix);
    if (partsEqual(oldParts, newParts)) return "no-op";
    const oldParent = oldParts.slice(0, -1);
    const newParent = newParts.slice(0, -1);
    if (oldParts.length === newParts.length && partsEqual(oldParent, newParent)) return "rename-node";
    if (oldParts.at(-1) === newParts.at(-1)) {
        if (newParts.length > oldParts.length && partsEqual(oldParts.slice(0, -1), newParts.slice(0, oldParts.length - 1))) {
            return "insert-parent";
        }
        if (oldParts.length > newParts.length && partsEqual(newParts.slice(0, -1), oldParts.slice(0, newParts.length - 1))) {
            return "remove-parent";
        }
        return "move-subtree";
    }
    return "move-and-rename";
}

function lineContext(content: string, from: number, to: number, replacement: string) {
    const lineStart = content.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
    const lineEndIndex = content.indexOf("\n", to);
    const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex;
    const line = content.slice(lineStart, lineEnd);
    const clippedStart = Math.max(0, from - lineStart - 48);
    const clippedEnd = Math.min(line.length, to - lineStart + 48);
    const before = line.slice(clippedStart, clippedEnd);
    const localFrom = from - lineStart - clippedStart;
    const localTo = to - lineStart - clippedStart;
    const after = before.slice(0, localFrom) + replacement + before.slice(localTo);
    return {
        line: content.slice(0, from).split("\n").length,
        column: from - lineStart + 1,
        contextBefore: `${clippedStart > 0 ? "…" : ""}${before}${clippedEnd < line.length ? "…" : ""}`,
        contextAfter: `${clippedStart > 0 ? "…" : ""}${after}${clippedEnd < line.length ? "…" : ""}`
    };
}

function replaceLinkTarget(rawInner: string, newStoredLabel: string): string {
    const parsed = parseEmbeddedLinks(`[[${rawInner}]]`)[0];
    if (!parsed) return `[[${rawInner}]]`;
    const bounds = targetBounds(parsed.text);
    let start = bounds.start;
    let end = bounds.end;
    while (start < end && /\s/.test(parsed.text[start])) start++;
    while (end > start && /\s/.test(parsed.text[end - 1])) end--;
    const encoded = encodeEmbeddedLabel(newStoredLabel, { relative: newStoredLabel.startsWith("/") });
    return `[[${parsed.text.slice(0, start)}${encoded}${parsed.text.slice(end)}]]`;
}

export function buildSafeRelabelPlan(
    blocks: RelabelBlockInput[],
    oldPrefix: string,
    newPrefix: string
): SafeRelabelPlan {
    const conflicts: string[] = [];
    const warnings: string[] = [];
    const labelError = validateBlockLabel(newPrefix);
    if (labelError) conflicts.push(labelError);
    if (isStrictDescendant(newPrefix, oldPrefix)) {
        conflicts.push(`Cannot move “${oldPrefix}” inside its own subtree.`);
    }

    const affected = blocks.filter(block => hasPathPrefix(block.label, oldPrefix));
    if (!affected.length) conflicts.push(`No block or descendant exists at “${oldPrefix}”.`);
    const affectedIds = new Set(affected.map(block => block.id));
    const blockChanges = affected.map(block => ({
        id: block.id,
        title: block.title,
        oldLabel: block.label,
        newLabel: replacePathPrefix(block.label, oldPrefix, newPrefix)
    }));

    const destinations = new Map<string, string>();
    for (const change of blockChanges) {
        const existing = destinations.get(change.newLabel);
        if (existing && existing !== change.id) conflicts.push(`Multiple blocks would become “${change.newLabel}”.`);
        destinations.set(change.newLabel, change.id);
        const invalid = validateBlockLabel(change.newLabel);
        if (invalid) conflicts.push(`${change.title}: ${invalid}`);
    }
    for (const block of blocks) {
        if (!affectedIds.has(block.id) && destinations.has(block.label)) {
            conflicts.push(`“${block.label}” is already occupied by “${block.title}”.`);
        }
    }

    const existingLabels = new Set(blocks.map(block => block.label));
    const referenceImpacts: RelabelReferenceImpact[] = [];
    for (const block of blocks) {
        const content = block.content || "";
        const newSourceLabel = replacePathPrefix(block.label, oldPrefix, newPrefix);
        for (const link of parseEmbeddedLinks(content)) {
            const oldTarget = link.relative ? block.label + link.label : link.label;
            const sourceMoved = newSourceLabel !== block.label;
            const targetMoved = hasPathPrefix(oldTarget, oldPrefix);
            if (!targetMoved && !(sourceMoved && link.relative)) continue;
            const newTarget = replacePathPrefix(oldTarget, oldPrefix, newPrefix);
            let newStoredLabel = newTarget;
            if (link.relative && isStrictDescendant(newTarget, newSourceLabel)) {
                newStoredLabel = "/" + splitPath(newTarget).slice(splitPath(newSourceLabel).length).join("/");
            }
            const newText = replaceLinkTarget(link.text, newStoredLabel);
            const oldText = link.rawText;
            const context = lineContext(content, link.from, link.to, newText);
            referenceImpacts.push({
                blockId: block.id,
                blockTitle: block.title,
                sourceLabel: block.label,
                from: link.from,
                to: link.to,
                ...context,
                oldText,
                newText,
                oldTarget,
                newTarget,
                changed: oldText !== newText,
                relative: link.relative,
                targetExists: existingLabels.has(oldTarget)
            });
        }
    }

    if (referenceImpacts.some(impact => !impact.targetExists)) {
        warnings.push("Some structurally updated links point to nodes that do not currently have blocks.");
    }
    return { oldPrefix, newPrefix, changeType: classifyRelabel(oldPrefix, newPrefix), blockChanges, referenceImpacts, conflicts: [...new Set(conflicts)], warnings };
}

export function applySafeRelabelPlan(blocks: RelabelBlockInput[], plan: SafeRelabelPlan): RelabelBlockInput[] {
    const labels = new Map(plan.blockChanges.map(change => [change.id, change.newLabel]));
    const impactsByBlock = new Map<string, RelabelReferenceImpact[]>();
    for (const impact of plan.referenceImpacts) {
        if (!impact.changed) continue;
        const impacts = impactsByBlock.get(impact.blockId) || [];
        impacts.push(impact);
        impactsByBlock.set(impact.blockId, impacts);
    }
    return blocks.map(block => {
        let content = block.content || "";
        for (const impact of (impactsByBlock.get(block.id) || []).sort((a, b) => b.from - a.from)) {
            if (content.slice(impact.from, impact.to) === impact.oldText) {
                content = content.slice(0, impact.from) + impact.newText + content.slice(impact.to);
            }
        }
        return { ...block, label: labels.get(block.id) || block.label, content };
    });
}
