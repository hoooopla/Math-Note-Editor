export interface ImageGeometry {
    width: number;
    height: number;
}

export function validImageGeometry(width: number, height: number): ImageGeometry | null {
    return Number.isInteger(width) && Number.isInteger(height)
        && width > 0 && height > 0 && width <= 100_000 && height <= 100_000
        ? { width, height }
        : null;
}

/** A failed or slow decode must never prevent an otherwise valid upload. */
export async function readImageGeometry(source: Blob | string): Promise<ImageGeometry | null> {
    const ownedUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
    const url = typeof source === 'string' ? source : ownedUrl!;
    try {
        return await new Promise(resolve => {
            const image = new Image();
            let finished = false;
            const finish = (geometry: ImageGeometry | null) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                image.onload = null;
                image.onerror = null;
                resolve(geometry);
            };
            const timeout = setTimeout(() => finish(null), 10_000);
            image.onload = () => finish(validImageGeometry(image.naturalWidth, image.naturalHeight));
            image.onerror = () => finish(null);
            image.src = url;
        });
    } finally {
        if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    }
}
