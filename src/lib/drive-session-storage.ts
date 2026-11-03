import type { WorkspaceSession } from '../store/api';

const keyFor = (folderId: string) => `math-note:drive-session:v1:${encodeURIComponent(folderId)}`;

function validSession(value: unknown): WorkspaceSession | null {
    if (!value || typeof value !== 'object') return null;
    const session = value as Partial<WorkspaceSession>;
    if (!Array.isArray(session.openTabs) || !session.openTabs.every(id => typeof id === 'string') ||
        (session.activeTab !== null && typeof session.activeTab !== 'string') ||
        (session.lockedTabs !== undefined && (!Array.isArray(session.lockedTabs) || !session.lockedTabs.every(id => typeof id === 'string')))) return null;
    return { openTabs: session.openTabs, activeTab: session.activeTab, lockedTabs: session.lockedTabs };
}

function read(kind: 'sessionStorage' | 'localStorage', key: string): WorkspaceSession | null {
    try { return validSession(JSON.parse(window[kind].getItem(key) || 'null')); }
    catch { return null; }
}

export function loadDriveSession(folderId: string, legacy?: WorkspaceSession): WorkspaceSession | null {
    const key = keyFor(folderId);
    const tabSession = read('sessionStorage', key);
    if (tabSession) return tabSession;
    const deviceSession = read('localStorage', key);
    if (deviceSession) {
        try { window.sessionStorage.setItem(key, JSON.stringify(deviceSession)); } catch { /* localStorage remains available */ }
        return deviceSession;
    }
    const migrated = validSession(legacy);
    if (migrated) saveDriveSession(folderId, migrated);
    return migrated;
}

export function saveDriveSession(folderId: string, session: WorkspaceSession): void {
    const key = keyFor(folderId);
    const serialized = JSON.stringify(session);
    let saved = false;
    try { window.sessionStorage.setItem(key, serialized); saved = true; } catch { /* try device storage */ }
    try { window.localStorage.setItem(key, serialized); saved = true; } catch { /* sessionStorage may still work */ }
    if (!saved) throw new Error('Browser storage is unavailable; this device cannot remember its open tabs.');
}
