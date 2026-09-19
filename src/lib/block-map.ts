import type { BlockData } from "../store";
import { splitPath } from "./utils/path";

export type BlockMapHealth = "empty" | "broken" | "orphan" | "duplicate";

export interface BlockMapNode extends BlockData {
    parentId: string | null;
    childIds: string[];
    incomingIds: string[];
    outgoingIds: string[];
    brokenTargets: string[];
    ambiguousTargets: string[];
    health: BlockMapHealth[];
    hierarchyDepth: number;
}

export interface BlockMapEdge {
    sourceId: string;
    targetId: string;
    kind: "hierarchy" | "reference";
    mentions?: number;
}

export interface BlockMapModel {
    nodes: BlockMapNode[];
    nodeById: Record<string, BlockMapNode>;
    edges: BlockMapEdge[];
    duplicateLabels: Set<string>;
}

function nearestExistingParentId(block: BlockData, uniqueIdByLabel: Map<string, string>): string | null {
    const parts = splitPath(block.label);
    for (let end = parts.length - 1; end > 0; end--) {
        const parentId = uniqueIdByLabel.get(parts.slice(0, end).join("/"));
        if (parentId) return parentId;
    }
    return null;
}

export function buildBlockMapModel(blocks: BlockData[]): BlockMapModel {
    const idsByLabel = new Map<string, string[]>();
    for (const block of blocks) idsByLabel.set(block.label, [...(idsByLabel.get(block.label) || []), block.id]);
    const duplicateLabels = new Set([...idsByLabel].filter(([, ids]) => ids.length > 1).map(([label]) => label));
    const uniqueIdByLabel = new Map([...idsByLabel].filter(([, ids]) => ids.length === 1).map(([label, ids]) => [label, ids[0]]));

    const mutable = new Map(blocks.map(block => [block.id, {
        ...block,
        parentId: nearestExistingParentId(block, uniqueIdByLabel),
        childIds: [] as string[],
        incomingIds: [] as string[],
        outgoingIds: [] as string[],
        brokenTargets: [] as string[],
        ambiguousTargets: [] as string[],
        health: [] as BlockMapHealth[],
        hierarchyDepth: 0
    }]));
    const edges: BlockMapEdge[] = [];

    for (const node of mutable.values()) {
        if (!node.parentId) continue;
        mutable.get(node.parentId)?.childIds.push(node.id);
        edges.push({ sourceId: node.parentId, targetId: node.id, kind: "hierarchy" });
    }

    for (const node of mutable.values()) {
        const mentionCount = new Map<string, number>();
        for (const rawReference of node.references || []) {
            const targetLabel = rawReference.startsWith("/") ? node.label + rawReference : rawReference;
            const targetId = uniqueIdByLabel.get(targetLabel);
            if (!targetId) {
                if (duplicateLabels.has(targetLabel)) {
                    if (!node.ambiguousTargets.includes(targetLabel)) node.ambiguousTargets.push(targetLabel);
                    continue;
                }
                if (!node.brokenTargets.includes(targetLabel)) node.brokenTargets.push(targetLabel);
                continue;
            }
            mentionCount.set(targetId, (mentionCount.get(targetId) || 0) + 1);
        }
        for (const [targetId, mentions] of mentionCount) {
            node.outgoingIds.push(targetId);
            mutable.get(targetId)?.incomingIds.push(node.id);
            edges.push({ sourceId: node.id, targetId, kind: "reference", mentions });
        }
    }

    const depthFor = (node: BlockMapNode, visiting = new Set<string>()): number => {
        if (!node.parentId) return 0;
        if (visiting.has(node.id)) return 0;
        visiting.add(node.id);
        const parent = mutable.get(node.parentId);
        return parent ? depthFor(parent, visiting) + 1 : 0;
    };

    for (const node of mutable.values()) {
        node.hierarchyDepth = depthFor(node);
        if (!node.hasContent) node.health.push("empty");
        if (node.brokenTargets.length > 0 || node.ambiguousTargets.length > 0) node.health.push("broken");
        if (duplicateLabels.has(node.label)) node.health.push("duplicate");
        if (!node.parentId && node.childIds.length === 0 && node.incomingIds.length === 0 && node.outgoingIds.length === 0 && !node.brokenTargets.length && !node.ambiguousTargets.length) {
            node.health.push("orphan");
        }
        node.childIds.sort();
        node.incomingIds.sort();
        node.outgoingIds.sort();
        node.brokenTargets.sort();
    }

    const nodes = blocks.map(block => mutable.get(block.id)!).filter(Boolean);
    return { nodes, nodeById: Object.fromEntries(nodes.map(node => [node.id, node])), edges, duplicateLabels };
}
