import type { BlockData } from '../store';
import { decodedAssetPath, encodedAssetReference, scanImageSourceSpans, validateAssetPath } from './asset-reference';

export interface AssetMoveImpact {
    blockId: string;
    title: string;
    fileName?: string;
    count: number;
    references: Array<{ before: string; after: string }>;
}

export interface AssetMovePlan {
    source: string;
    destination: string;
    sourceVersion: string;
    revision: string;
    conflicts: string[];
    impacts: AssetMoveImpact[];
}

export function normalizeAssetMovePath(value: string): string {
    const relative = value.replace(/^assets\//, '');
    const error = validateAssetPath(relative);
    if (error) throw new Error(error);
    return `assets/${relative}`;
}

export function replaceAssetImageReferences(content: string, source: string, destination: string): { content: string; references: Array<{ before: string; after: string }> } {
    const spans = scanImageSourceSpans(content).filter(image => decodedAssetPath(image.src.split(/[?#]/, 1)[0]) === source);
    const references = spans.map(image => {
        const before = content.slice(image.sourceFrom, image.sourceTo);
        const suffixIndex = before.search(/[?#]/);
        const suffix = suffixIndex < 0 ? '' : before.slice(suffixIndex);
        return { before, after: `${encodedAssetReference(destination)}${suffix}` };
    });
    let updated = content;
    for (let index = spans.length - 1; index >= 0; index--) {
        const span = spans[index];
        updated = updated.slice(0, span.sourceFrom) + references[index].after + updated.slice(span.sourceTo);
    }
    return { content: updated, references };
}

export function buildAssetMovePlan(blocks: BlockData[], assets: string[], sourceInput: string, destinationInput: string, sourceVersion: string): AssetMovePlan {
    const source = normalizeAssetMovePath(sourceInput);
    const destination = normalizeAssetMovePath(destinationInput);
    const conflicts: string[] = [];
    if (!/\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(source)) conflicts.push('Only image assets can be moved here.');
    if (source === destination) conflicts.push('Choose a different destination.');
    const extension = (path: string) => path.split('/').at(-1)?.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || '';
    if (extension(source) !== extension(destination)) conflicts.push('Keep the original file extension; renaming does not convert an image.');
    if (!assets.includes(source)) conflicts.push('The source asset no longer exists.');
    if (assets.some(path => path.toLocaleLowerCase() === destination.toLocaleLowerCase())) conflicts.push('An asset already exists at the destination (names may be case-insensitive).');
    if (assets.filter(path => path === source).length !== 1) conflicts.push('The source path is ambiguous; resolve duplicate assets before moving it.');
    const impacts = blocks.flatMap(block => {
        const references = replaceAssetImageReferences(block.content || '', source, destination).references;
        return references.length ? [{ blockId: block.id, title: block.title, fileName: block._fileMeta?.fileName,
            count: references.length, references }] : [];
    });
    // Other link syntaxes are not rewritten. Refuse a move rather than silently
    // leaving a reachable image link pointing to the removed source file.
    const spellings = [...new Set([source, encodedAssetReference(source), `/api/${source}`, `/api/${encodedAssetReference(source)}`])];
    for (const block of blocks) {
        const content = block.content || '';
        const handled = scanImageSourceSpans(content)
            .filter(image => decodedAssetPath(image.src.split(/[?#]/, 1)[0]) === source);
        let unmanaged = false;
        for (const spelling of spellings) {
            let position = content.indexOf(spelling);
            while (position >= 0) {
                if (!handled.some(span => position >= span.sourceFrom && position + spelling.length <= span.sourceTo)) {
                    unmanaged = true;
                    break;
                }
                position = content.indexOf(spelling, position + spelling.length);
            }
            if (unmanaged) break;
        }
        if (unmanaged) conflicts.push(`“${block.title}” also mentions this path outside a supported image reference. Update that reference manually before moving the file.`);
    }
    return { source, destination, sourceVersion, revision: '', conflicts, impacts };
}

export function assetMoveRevisionInput(blocks: BlockData[], assets: string[], plan: AssetMovePlan): string {
    return JSON.stringify({ source: plan.source, destination: plan.destination, sourceVersion: plan.sourceVersion,
        assets: [...assets].sort(), notes: blocks.map(block => [block.id, block.title, block.label, block.content || '']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
}
