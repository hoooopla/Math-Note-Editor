export const IMAGE_MIME_TYPES = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'
] as const;

const imageTypes = new Set<string>(IMAGE_MIME_TYPES);
const imageExtensions: Record<string, string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg', 'jpe'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'image/avif': ['avif'],
    'image/bmp': ['bmp']
};
const megabyte = 1024 * 1024;

export function imageUploadLimit(mode: 'server' | 'local' | 'google' | 'none' | 'viewer'): number {
    if (mode === 'google') return 5 * megabyte;
    if (mode === 'server') return 12 * megabyte; // Below the server's 20 MB base64 JSON limit.
    return 50 * megabyte;
}

export function validateImageUpload(file: { type: string; size: number }, mode: 'server' | 'local' | 'google' | 'none' | 'viewer'): string | null {
    if (!imageTypes.has(file.type.toLowerCase())) {
        return 'Choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image. Existing SVG references remain readable.';
    }
    if (file.size === 0) return 'The image file is empty.';
    const limit = imageUploadLimit(mode);
    if (file.size > limit) return `Image exceeds the ${Math.round(limit / megabyte)} MB limit for this workspace.`;
    return null;
}

export function validateImageFilename(path: string, mimeType: string): string | null {
    const extensions = imageExtensions[mimeType.toLowerCase()];
    if (!extensions) return 'Unsupported image format.';
    const extension = path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase();
    if (extension && extensions.includes(extension)) return null;
    return `Use a .${extensions[0]} file name for this image format.`;
}

export function imageSignatureMatches(bytes: Uint8Array, mimeType: string): boolean {
    const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
    switch (mimeType.toLowerCase()) {
        case 'image/png':
            return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
        case 'image/jpeg':
            return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        case 'image/gif':
            return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
        case 'image/webp':
            return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
        case 'image/avif':
            if (ascii(4, 4) !== 'ftyp') return false;
            for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
                if (['avif', 'avis'].includes(ascii(offset, 4))) return true;
            }
            return false;
        case 'image/bmp':
            return ascii(0, 2) === 'BM';
        default:
            return false;
    }
}
