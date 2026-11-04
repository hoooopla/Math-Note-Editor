import { markdownLanguage } from '@codemirror/lang-markdown';
import { BlockData } from '../store';
import { parseEmbeddedLinks, resolveEmbeddedLabel } from './embedded-link-syntax';

export interface OutlineNode {
    key: string;
    kind: 'heading' | 'standout' | 'inline';
    title: string;
    blockId: string;
    from: number;
    level?: number;
    // Each segment identifies a particular occurrence, even if a note is embedded twice.
    path: { blockId: string; from: number }[];
    children: OutlineNode[];
    unloaded?: boolean;
}

export function buildContentOutline(rootId: string, blocksById: Record<string, BlockData>, idsByLabel: Record<string, string>): OutlineNode[] {
    const visit = (blockId: string, path: OutlineNode['path'], visited: Set<string>): OutlineNode[] => {
        const block = blocksById[blockId];
        if (!block?.content) return [];
        const content = block.content;
        const events: ({ kind: 'heading'; from: number; level: number; title: string } | { kind: 'standout' | 'inline'; from: number; label: string; title: string })[] = [];
        // Use CodeMirror's Markdown grammar so # inside code fences is not a heading.
        markdownLanguage.parser.parse(content).iterate({ enter(node) {
            const match = /^ATXHeading([1-6])$/.exec(node.name);
            if (!match) return;
            const title = content.slice(node.from, node.to).replace(/^\s{0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
            if (title) events.push({ kind: 'heading', from: node.from, level: Number(match[1]), title });
        } });
        for (const link of parseEmbeddedLinks(content)) {
            const label = resolveEmbeddedLabel(link, block.label);
            const target = blocksById[idsByLabel[label]];
            events.push({ kind: link.standout ? 'standout' : 'inline', from: link.from, label, title: link.alias || target?.title || label });
        }
        events.sort((a, b) => a.from - b.from);
        const roots: OutlineNode[] = [];
        const headings: OutlineNode[] = [];
        for (const event of events) {
            if (event.kind === 'heading') {
                while (headings.length && (headings.at(-1)?.level || 0) >= event.level) headings.pop();
                const node: OutlineNode = { key: `${rootId}:${path.map(p => `${p.blockId}@${p.from}`).join('/')}:${blockId}:h${event.from}`, kind: 'heading', title: event.title, blockId, from: event.from, level: event.level, path, children: [] };
                (headings.at(-1)?.children || roots).push(node);
                headings.push(node);
            } else {
                const targetId = idsByLabel[event.label];
                const target = blocksById[targetId];
                const nextPath = [...path, { blockId: targetId, from: event.from }];
                const node: OutlineNode = {
                    key: `${rootId}:${path.map(p => `${p.blockId}@${p.from}`).join('/')}:${blockId}:e${event.from}`,
                    kind: event.kind, title: event.title, blockId, from: event.from, path,
                    children: target && !visited.has(targetId) ? visit(targetId, nextPath, new Set([...visited, targetId])) : [],
                    unloaded: !!target && target.content === undefined && !visited.has(targetId)
                };
                (headings.at(-1)?.children || roots).push(node);
            }
        }
        return roots;
    };
    return visit(rootId, [], new Set([rootId]));
}
