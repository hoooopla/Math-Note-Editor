export interface SearchableBlock {
    id: string;
    title: string;
    label: string;
}

const naturalLabelOrder = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base'
});

function alphabeticalByLabel(a: SearchableBlock, b: SearchableBlock) {
    return naturalLabelOrder.compare(a.label, b.label)
        || naturalLabelOrder.compare(a.title, b.title)
        || a.id.localeCompare(b.id);
}

function relevanceTier(block: SearchableBlock, query: string) {
    const label = block.label.toLocaleLowerCase();
    const title = block.title.toLocaleLowerCase();
    if (label === query) return 0;
    if (label.startsWith(query)) return 1;
    if (label.split('/').some(segment => segment.startsWith(query))) return 2;
    if (title === query || title.startsWith(query)) return 3;
    if (label.includes(query)) return 4;
    if (title.includes(query)) return 5;
    return null;
}

export function rankSearchResults<T extends SearchableBlock>(
    blocks: T[],
    query: string,
    recentIds: string[] = [],
    recentLimit = 10
): T[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery) {
        return blocks
            .map(block => ({ block, tier: relevanceTier(block, normalizedQuery) }))
            .filter((item): item is { block: T, tier: number } => item.tier !== null)
            .sort((a, b) => a.tier - b.tier || alphabeticalByLabel(a.block, b.block))
            .map(item => item.block);
    }

    const blocksById = new Map(blocks.map(block => [block.id, block]));
    const recent: T[] = [];
    const seen = new Set<string>();
    for (const id of recentIds) {
        const block = blocksById.get(id);
        if (!block || seen.has(id)) continue;
        recent.push(block);
        seen.add(id);
        if (recent.length === recentLimit) break;
    }
    return [
        ...recent,
        ...blocks.filter(block => !seen.has(block.id)).sort(alphabeticalByLabel)
    ];
}
