import { api } from '../store/api';

export interface TextMatch { from: number; to: number }

export function findTextMatches(content: string, query: string, caseSensitive = false, wholeWord = false, limit = 500): TextMatch[] {
    if (!query) return [];
    // RegExp indices refer to the original string. Lowercasing the whole note
    // can change its length (for example, İ), shifting every later result.
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(literal, caseSensitive ? 'gu' : 'giu');
    const matches: TextMatch[] = [];
    for (const found of content.matchAll(expression)) {
        const from = found.index;
        const to = from + found[0].length;
        const before = content[from - 1] || '';
        const after = content[to] || '';
        if (!wholeWord || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))) matches.push({ from, to });
        if (matches.length >= limit) break;
    }
    return matches;
}

export function matchExcerpt(content: string, match: TextMatch): { before: string; matched: string; after: string } {
    const start = Math.max(0, content.lastIndexOf('\n', match.from - 1) + 1, match.from - 45);
    const lineEnd = content.indexOf('\n', match.to);
    const end = Math.min(lineEnd < 0 ? content.length : lineEnd, match.to + 75);
    return {
        before: `${start > 0 && content[start - 1] !== '\n' ? '…' : ''}${content.slice(start, match.from)}`,
        matched: content.slice(match.from, match.to),
        after: `${content.slice(match.to, end)}${end < content.length && content[end] !== '\n' ? '…' : ''}`
    };
}

let cacheRevision = -1;
const bodyCache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export function resetContentFindCache(workspaceRevision: number) {
    if (cacheRevision === workspaceRevision) return;
    cacheRevision = workspaceRevision;
    bodyCache.clear();
    pending.clear();
}

export async function readIndexedBody(id: string, workspaceRevision: number): Promise<string | null> {
    resetContentFindCache(workspaceRevision);
    if (bodyCache.has(id)) return bodyCache.get(id)!;
    let request = pending.get(id);
    if (!request) {
        request = api.loadBlockContent(id).then(block => {
            if (cacheRevision === workspaceRevision && block?.content !== undefined) bodyCache.set(id, block.content);
            return block?.content ?? null;
        }).finally(() => { if (cacheRevision === workspaceRevision) pending.delete(id); });
        pending.set(id, request);
    }
    return request;
}

export function cachedBody(id: string) { return bodyCache.get(id); }
