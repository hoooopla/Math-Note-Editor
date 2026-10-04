import { registerEmbeddedPanelScrollGuard } from "./embedded-scroll-coordinator";

export type EmbeddedEditorPhase = "warm" | "hot";

interface OccurrenceRecord {
    phase: EmbeddedEditorPhase;
    listeners: Set<(phase: EmbeddedEditorPhase) => void>;
}

const occurrenceRecords = new Map<string, OccurrenceRecord>();
const panelByOccurrence = new Map<string, HTMLElement>();
let hotOccurrencesByPanel = new WeakMap<HTMLElement, Set<string>>();
let fallbackHotOccurrenceKey: string | null = null;
const MAX_OCCURRENCE_RECORDS = 1024;

function trimInactiveOccurrenceRecords() {
    if (occurrenceRecords.size <= MAX_OCCURRENCE_RECORDS) return;
    for (const [key, record] of occurrenceRecords) {
        if (occurrenceRecords.size <= MAX_OCCURRENCE_RECORDS) break;
        if (record.phase === "hot" || record.listeners.size > 0 || panelByOccurrence.has(key)) continue;
        occurrenceRecords.delete(key);
    }
}

function occurrencePath(key: string): string[] {
    try {
        const parsed = JSON.parse(key);
        return Array.isArray(parsed) && parsed.every(segment => typeof segment === "string")
            ? parsed
            : [];
    } catch {
        return [];
    }
}

function isOccurrenceAncestor(candidate: string, target: string) {
    const candidatePath = occurrencePath(candidate);
    const targetPath = occurrencePath(target);
    return candidatePath.length > 0 && candidatePath.length <= targetPath.length &&
        candidatePath.every((segment, index) => segment === targetPath[index]);
}

function recordFor(key: string): OccurrenceRecord {
    let record = occurrenceRecords.get(key);
    if (!record) {
        record = {
            phase: "warm",
            listeners: new Set()
        };
        occurrenceRecords.set(key, record);
        trimInactiveOccurrenceRecords();
    } else {
        // Treat the map as an LRU without disturbing records that currently
        // have mounted listeners. Source positions are part of occurrence keys,
        // so ordinary edits would otherwise retain obsolete records forever.
        occurrenceRecords.delete(key);
        occurrenceRecords.set(key, record);
    }
    return record;
}

function publishPhase(key: string, phase: EmbeddedEditorPhase) {
    const record = recordFor(key);
    if (record.phase === phase) return;
    record.phase = phase;
    record.listeners.forEach(listener => listener(phase));
}

export function initialEmbeddedEditorPhase(key: string): EmbeddedEditorPhase {
    return recordFor(key).phase;
}

export function subscribeEmbeddedEditorPhase(key: string, listener: (phase: EmbeddedEditorPhase) => void) {
    const record = recordFor(key);
    record.listeners.add(listener);
    // Promotion can happen from keyboard navigation before a lazily loaded
    // occurrence has registered its host. Synchronize that retained phase as
    // soon as the real editor subscribes.
    listener(record.phase);
    return () => record.listeners.delete(listener);
}

export function registerEmbeddedOccurrence(
    key: string,
    host: HTMLElement
) {
    const panel = host.closest<HTMLElement>('[role="tabpanel"]');
    if (!panel) return () => undefined;
    panelByOccurrence.set(key, panel);
    const unregisterScrollGuard = registerEmbeddedPanelScrollGuard(panel);
    const hot = hotOccurrencesByPanel.get(panel) ?? new Set<string>();
    if (recordFor(key).phase === "hot" || Array.from(hot).some(target => isOccurrenceAncestor(key, target))) {
        publishPhase(key, "hot");
        hot.add(key);
        hotOccurrencesByPanel.set(panel, hot);
    } else {
        publishPhase(key, "warm");
    }
    return () => {
        if (panelByOccurrence.get(key) === panel) panelByOccurrence.delete(key);
        const currentHot = hotOccurrencesByPanel.get(panel);
        currentHot?.delete(key);
        if (currentHot?.size === 0) hotOccurrencesByPanel.delete(panel);
        unregisterScrollGuard();
        trimInactiveOccurrenceRecords();
    };
}

export function promoteEmbeddedOccurrence(key: string) {
    const panel = panelByOccurrence.get(key);
    if (panel) {
        const hot = hotOccurrencesByPanel.get(panel) ?? new Set<string>();
        // Keep the full active ancestry editable. A child boundary must be
        // able to focus its parent synchronously; demoting the parent made the
        // selection move visually while DOM focus stayed trapped in the child.
        for (const previous of Array.from(hot)) {
            if (!isOccurrenceAncestor(previous, key)) {
                publishPhase(previous, "warm");
                hot.delete(previous);
            }
        }
        for (const [candidate, candidatePanel] of panelByOccurrence) {
            if (candidatePanel === panel && isOccurrenceAncestor(candidate, key)) {
                publishPhase(candidate, "hot");
                hot.add(candidate);
            }
        }
        hot.add(key);
        hotOccurrencesByPanel.set(panel, hot);
    } else {
        if (fallbackHotOccurrenceKey && fallbackHotOccurrenceKey !== key) publishPhase(fallbackHotOccurrenceKey, "warm");
        fallbackHotOccurrenceKey = key;
    }
    publishPhase(key, "hot");
}

export function demoteEmbeddedOccurrence(key: string) {
    const panel = panelByOccurrence.get(key);
    if (panel) {
        const hot = hotOccurrencesByPanel.get(panel);
        hot?.delete(key);
        if (hot?.size === 0) hotOccurrencesByPanel.delete(panel);
    }
    if (fallbackHotOccurrenceKey === key) fallbackHotOccurrenceKey = null;
    if (recordFor(key).phase === "hot") publishPhase(key, "warm");
}

export function embeddedContentFingerprint(content: string) {
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
        hash ^= content.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function resetEmbeddedEditorLifecycle() {
    occurrenceRecords.clear();
    panelByOccurrence.clear();
    hotOccurrencesByPanel = new WeakMap<HTMLElement, Set<string>>();
    fallbackHotOccurrenceKey = null;
}

export function getEmbeddedEditorLifecycleStateForTests() {
    return {
        occurrences: occurrenceRecords.size,
        maximumOccurrences: MAX_OCCURRENCE_RECORDS
    };
}
