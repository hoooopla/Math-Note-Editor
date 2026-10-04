import { useStore } from "../store";
import { parseEmbeddedLinks, resolveEmbeddedLabel } from "./embedded-link-syntax";

export const EMBEDDED_PREFETCH_MAX_CONCURRENCY = 4;
export const EMBEDDED_PREFETCH_MAX_DEPTH = 3;
export const EMBEDDED_PREFETCH_MAX_BLOCKS = 40;
export const EMBEDDED_PREFETCH_AHEAD_SCREENS = 4;

type PrefetchPriority = "viewport" | "descendant";
type QueuedPrefetch = {
    run: () => Promise<void>;
    priority: number;
    order: number;
};

const queue = new Map<string, QueuedPrefetch>();
const inFlight = new Set<string>();
const pendingPromises = new Map<string, Promise<void>>();
let workspaceGeneration = 0;
let enqueueOrder = 0;

function drainQueue() {
    while (inFlight.size < EMBEDDED_PREFETCH_MAX_CONCURRENCY) {
        const next = Array.from(queue.entries()).sort((a, b) =>
            a[1].priority - b[1].priority || a[1].order - b[1].order
        )[0];
        if (!next) return;
        const [id, task] = next;
        queue.delete(id);
        inFlight.add(id);
        void task.run().catch(error => console.warn("Embedded note prefetch failed", error)).finally(() => {
            inFlight.delete(id);
            drainQueue();
        });
    }
}

export function scheduleEmbeddedBlockPrefetch(
    id: string,
    load: () => Promise<void>,
    priority: PrefetchPriority = "viewport"
): Promise<void> {
    // A failed automatic load remains an explicit, retryable UI state. Do not
    // let another viewport/prefetch effect immediately hide the error by
    // issuing an unrequested second attempt.
    if (useStore.getState().blockLoadErrors[id]) return Promise.resolve();
    const generation = workspaceGeneration;
    const taskKey = `${generation}:${id}`;
    const existing = pendingPromises.get(taskKey);
    if (existing) {
        const queued = queue.get(taskKey);
        // A host entering the three-page render-ahead window must jump ahead
        // of speculative recursive work that happened to discover it first.
        if (queued && priority === "viewport") queued.priority = 0;
        return existing;
    }
    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
    });
    pendingPromises.set(taskKey, promise);
    queue.set(taskKey, {
        priority: priority === "viewport" ? 0 : 1,
        order: enqueueOrder++,
        run: async () => {
            try {
                if (generation === workspaceGeneration) await load();
                resolveTask();
            } catch (error) {
                rejectTask(error);
                throw error;
            } finally {
                pendingPromises.delete(taskKey);
            }
        }
    });
    drainQueue();
    return promise;
}

interface PrefetchContext {
    remaining: number;
    seenIds: Set<string>;
}

function enqueueOpenDescendants(content: string, parentLabel: string, depth: number, context: PrefetchContext) {
    if (depth > EMBEDDED_PREFETCH_MAX_DEPTH || context.remaining <= 0) return;
    const state = useStore.getState();
    for (const link of parseEmbeddedLinks(content)) {
        if (!link.open || context.remaining <= 0) continue;
        const label = resolveEmbeddedLabel(link, parentLabel);
        const id = state.blockIdByLabel[label];
        if (!id || context.seenIds.has(id)) continue;
        context.seenIds.add(id);
        context.remaining -= 1;
        void scheduleEmbeddedBlockPrefetch(id, async () => {
            const before = useStore.getState().blocksById[id];
            if (before?.content === undefined) await useStore.getState().loadBlockContent(id);
        }, "descendant").then(() => {
            const loaded = useStore.getState().blocksById[id];
            if (loaded?.content !== undefined && depth < EMBEDDED_PREFETCH_MAX_DEPTH) {
                enqueueOpenDescendants(loaded.content, label, depth + 1, context);
            }
        }).catch(() => undefined);
    }
}

export function scheduleEmbeddedDescendantPrefetch(content: string, parentLabel: string, alreadyVisitedIds: string[] = []) {
    const context: PrefetchContext = {
        remaining: EMBEDDED_PREFETCH_MAX_BLOCKS,
        seenIds: new Set(alreadyVisitedIds)
    };
    enqueueOpenDescendants(content, parentLabel, 1, context);
}

export function getEmbeddedPrefetchStateForTests() {
    return { queued: queue.size, inFlight: inFlight.size };
}

export function resetEmbeddedPrefetchWorkspace() {
    workspaceGeneration += 1;
}
