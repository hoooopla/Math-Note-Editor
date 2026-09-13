import { normalizeBlockLabel } from "./label-policy";

export interface WorkspaceBlockSummary {
    id: string;
    title: string;
    label: string;
    fileName?: string;
}

export interface DuplicateLabelIssue {
    label: string;
    blocks: WorkspaceBlockSummary[];
}

export function findDuplicateLabelIssues(blocks: WorkspaceBlockSummary[]): DuplicateLabelIssue[] {
    const byLabel = new Map<string, WorkspaceBlockSummary[]>();
    for (const block of blocks) {
        const label = normalizeBlockLabel(block.label);
        const group = byLabel.get(label) || [];
        group.push({ ...block, label });
        byLabel.set(label, group);
    }
    return Array.from(byLabel.entries())
        .filter(([, group]) => group.length > 1)
        .map(([label, group]) => ({
            label,
            blocks: group.sort((left, right) =>
                (left.fileName || left.title || left.id).localeCompare(right.fileName || right.title || right.id)
            )
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
}
