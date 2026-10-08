/** Asset names are filesystem names, not URL fragments. Never silently rewrite one. */
import { ImageGeometry, validImageGeometry } from './image-geometry';
import { parser as markdownParser } from '@lezer/markdown';

export function validateAssetPath(path: string): string | null {
    if (!path || path.startsWith('/') || path.includes('\\')) return 'Choose a name inside assets.';
    const segments = path.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment !== segment.trim())) {
        return 'Folder and file names cannot be empty, “.”, “..”, or start/end with a space.';
    }
    if (segments.some(segment => /[\x00-\x1f<>:"|?*]/.test(segment) || segment.endsWith('.'))) {
        return 'Names cannot contain control characters, < > : " | ? *, or end with a period.';
    }
    if (segments.some(segment => new TextEncoder().encode(segment).length > 255)) {
        return 'Each folder and file name must be at most 255 bytes.';
    }
    return null;
}

export function encodedAssetReference(path: string): string {
    const relative = path.replace(/^(?:\/api\/)?assets\//, '');
    return `assets/${relative.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
}

export function decodedAssetPath(reference: string): string | null {
    const match = reference.match(/^(?:\/api\/)?assets\/(.+)$/);
    if (!match) return null;
    try {
        const relative = match[1].split('/').map(segment => decodeURIComponent(segment)).join('/');
        return validateAssetPath(relative) ? null : `assets/${relative}`;
    } catch {
        // Old notes may contain a literal percent sign that is not an escape.
        return validateAssetPath(match[1]) ? null : `assets/${match[1]}`;
    }
}

export function imageReference(path: string, width: string, alt = '', geometry?: ImageGeometry | null): string {
    const widthAttribute = width ? ` width="${width}"` : '';
    const altAttribute = alt ? ` alt="${alt.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"` : '';
    const dimensions = geometry && validImageGeometry(geometry.width, geometry.height);
    const geometryAttributes = dimensions
        ? ` data-natural-width="${dimensions.width}" data-natural-height="${dimensions.height}"` : '';
    return `<img src="${encodedAssetReference(path)}"${widthAttribute}${altAttribute}${geometryAttributes} />`;
}

export function validateImageWidth(width: string): string | null {
    if (!width) return null;
    if (/^[1-9]\d{0,3}$/.test(width) && Number(width) <= 8192) return null;
    if (/^(?:[1-9]\d?|100)%$/.test(width)) return null;
    return 'Width must be 1–8192 pixels or 1–100%.';
}

export interface ParsedImageReference {
    from: number;
    to: number;
    src: string;
    width: string;
    geometry?: ImageGeometry;
}

export interface ImageSourceSpan extends ParsedImageReference {
    sourceFrom: number;
    sourceTo: number;
}

function htmlImageAt(text: string, from: number): ImageSourceSpan | null {
    if (text.slice(from, from + 4).toLowerCase() !== '<img' || !/[\s/>]/.test(text[from + 4] || '')) return null;
    let end = from + 4;
    let quote = '';
    for (; end < text.length; end++) {
        const char = text[end];
        if (quote) {
            if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            break;
        }
    }
    if (end >= text.length) return null;
    const tag = text.slice(from + 4, end);
    const attributes = new Map<string, string>();
    let sourceFrom = -1;
    let sourceTo = -1;
    let index = 0;
    while (index < tag.length) {
        while (/[\s/]/.test(tag[index] || '')) index++;
        const nameStart = index;
        while (/[\w:-]/.test(tag[index] || '')) index++;
        if (index === nameStart) { index++; continue; }
        const name = tag.slice(nameStart, index).toLowerCase();
        while (/\s/.test(tag[index] || '')) index++;
        if (tag[index] !== '=') continue;
        index++;
        while (/\s/.test(tag[index] || '')) index++;
        let value = '';
        const delimiter = tag[index];
        if (delimiter === '"' || delimiter === "'") {
            index++;
            const valueStart = index;
            while (index < tag.length && tag[index] !== delimiter) index++;
            value = tag.slice(valueStart, index);
            if (name === 'src' && sourceFrom < 0) { sourceFrom = from + 4 + valueStart; sourceTo = from + 4 + index; }
            if (index < tag.length) index++;
        } else {
            const valueStart = index;
            while (index < tag.length && !/\s/.test(tag[index])) index++;
            value = tag.slice(valueStart, index);
            if (name === 'src' && sourceFrom < 0) { sourceFrom = from + 4 + valueStart; sourceTo = from + 4 + index; }
        }
        if (!attributes.has(name)) attributes.set(name, value);
    }
    const src = attributes.get('src');
    if (!src || sourceFrom < 0) return null;
    const geometry = validImageGeometry(
        Number(attributes.get('data-natural-width')),
        Number(attributes.get('data-natural-height'))
    );
    return { from, to: end + 1, sourceFrom, sourceTo, src: src.replace(/&amp;/g, '&'), width: attributes.get('width') || '',
        ...(geometry ? { geometry } : {}) };
}

function markdownImageAt(text: string, from: number): ImageSourceSpan | null {
    if (text.slice(from, from + 2) !== '![') return null;
    let index = from + 2;
    let bracketDepth = 1;
    for (; index < text.length; index++) {
        if (text[index] === '\\') { index++; continue; }
        if (text[index] === '[') bracketDepth++;
        if (text[index] === ']' && --bracketDepth === 0) break;
    }
    if (text[index] !== ']' || text[index + 1] !== '(') return null;
    const destinationStart = index + 2;
    index = destinationStart;
    let depth = 1;
    for (; index < text.length; index++) {
        if (text[index] === '\\') { index++; continue; }
        if (text[index] === '(') depth++;
        if (text[index] === ')' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    const rawDestination = text.slice(destinationStart, index);
    let destination = rawDestination.trim();
    let sourceFrom = destinationStart + rawDestination.indexOf(destination);
    let sourceTo = sourceFrom + destination.length;
    if (destination.startsWith('<')) {
        const close = destination.indexOf('>');
        if (close < 0) return null;
        sourceFrom++;
        sourceTo = sourceFrom + close - 1;
        destination = destination.slice(1, close);
    } else {
        destination = destination.replace(/\s+(?:"[^"]*"|'[^']*')$/, '');
        sourceTo = sourceFrom + destination.length;
    }
    const src = destination.replace(/\\([\\()])/g, '$1');
    return src ? { from, to: index + 1, sourceFrom, sourceTo, src, width: '' } : null;
}

/** Offsets are relative to text. Keep old raw paths and encoded paths unchanged here. */
export function scanImageSourceSpans(text: string): ImageSourceSpan[] {
    const images: ImageSourceSpan[] = [];
    const codeRanges: Array<{ from: number; to: number }> = [];
    markdownParser.parse(text).iterate({ enter(node) {
        if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') {
            codeRanges.push({ from: node.from, to: node.to });
            return false;
        }
    } });
    for (let index = 0; index < text.length; index++) {
        const image = text[index] === '<' ? htmlImageAt(text, index)
            : text[index] === '!' ? markdownImageAt(text, index) : null;
        if (!image) continue;
        if (!codeRanges.some(range => image.from < range.to && image.to > range.from)) images.push(image);
        index = image.to - 1;
    }
    return images;
}

export function scanImageReferences(text: string): ParsedImageReference[] {
    return scanImageSourceSpans(text).map(({ sourceFrom: _sourceFrom, sourceTo: _sourceTo, ...image }) => image);
}
