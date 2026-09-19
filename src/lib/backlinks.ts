import type { BlockData } from "../store";
import { parseEmbeddedLinks, resolveEmbeddedLabel } from "./embedded-link-syntax";

export interface BacklinkOccurrence {
    from: number;
    to: number;
    line: string;
}

export function buildBacklinkIndex(blocks: BlockData[]): Record<string, string[]> {
    const index: Record<string, string[]> = Object.create(null);
    for (const source of blocks) {
        const targets = new Set(
            (source.references || [])
                .map(label => label.startsWith("/") ? source.label + label : label)
                .filter(Boolean)
        );
        for (const target of targets) {
            (index[target] ||= []).push(source.id);
        }
    }
    return index;
}

export function findBacklinkOccurrences(content: string, sourceLabel: string, targetLabel: string): BacklinkOccurrence[] {
    return parseEmbeddedLinks(content)
        .filter(link => resolveEmbeddedLabel(link, sourceLabel) === targetLabel)
        .map(link => {
            const lineStart = content.lastIndexOf("\n", Math.max(0, link.from - 1)) + 1;
            const nextNewline = content.indexOf("\n", link.to);
            const lineEnd = nextNewline === -1 ? content.length : nextNewline;
            return {
                from: link.from,
                to: link.to,
                line: content.slice(lineStart, lineEnd).trim()
            };
        });
}
