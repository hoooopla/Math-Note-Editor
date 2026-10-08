import { decodedAssetPath } from '../asset-reference';
import { ImageGeometry, validImageGeometry } from '../image-geometry';

interface ResourceEntry {
    refs: number;
    promise: Promise<string>;
    url: string | null;
}

const resources = new Map<string, ResourceEntry>();
const geometry = new Map<string, ImageGeometry>();
const MAX_GEOMETRY_ENTRIES = 512;
let workspaceEpoch = 0;

function sourceKey(src: string) {
    return decodedAssetPath(src) || src;
}

function geometryKey(src: string) {
    return `${workspaceEpoch}:${sourceKey(src)}`;
}

export function knownImageGeometry(src: string): ImageGeometry | null {
    if (src.length > 2_048) return null;
    const key = geometryKey(src);
    const result = geometry.get(key) || null;
    if (result) {
        geometry.delete(key);
        geometry.set(key, result);
    }
    return result;
}

export function rememberImageGeometry(src: string, value: ImageGeometry, epoch = workspaceEpoch) {
    const checked = validImageGeometry(value.width, value.height);
    if (!checked || src.length > 2_048 || epoch !== workspaceEpoch) return;
    const key = geometryKey(src);
    geometry.delete(key);
    geometry.set(key, checked);
    if (geometry.size > MAX_GEOMETRY_ENTRIES) geometry.delete(geometry.keys().next().value!);
}

export function invalidateImageAsset(path: string) {
    geometry.delete(geometryKey(path));
}

export function resetImageResourceWorkspace() {
    workspaceEpoch += 1;
    geometry.clear();
    // Active widgets still own their URLs. Their leases release them on unmount.
}

export function imageWorkspaceEpoch() {
    return workspaceEpoch;
}

/** Repeated visible references share one backend lookup/blob URL until their last widget unmounts. */
export function acquireImageUrl(src: string, revision: number, resolve: () => Promise<string>) {
    const key = `${workspaceEpoch}:${revision}:${sourceKey(src)}`;
    let entry = resources.get(key);
    if (!entry) {
        entry = { refs: 0, promise: Promise.resolve(''), url: null };
        const current = entry;
        current.promise = Promise.resolve().then(resolve).then(url => {
            current.url = url;
            if (current.refs === 0) {
                if (url.startsWith('blob:')) URL.revokeObjectURL(url);
                if (resources.get(key) === current) resources.delete(key);
            }
            return url;
        }, error => {
            if (resources.get(key) === current) resources.delete(key);
            throw error;
        });
        resources.set(key, current);
    }
    entry.refs += 1;
    const held = entry;
    let released = false;
    return {
        promise: held.promise,
        release: () => {
            if (released) return;
            released = true;
            held.refs -= 1;
            if (held.refs !== 0 || !held.url) return;
            if (held.url.startsWith('blob:')) URL.revokeObjectURL(held.url);
            if (resources.get(key) === held) resources.delete(key);
        }
    };
}
