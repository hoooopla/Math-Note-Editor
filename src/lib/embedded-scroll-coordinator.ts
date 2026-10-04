interface PanelScrollState {
    lastScrollTop: number;
    userScrollVersion: number;
    scrolling: boolean;
    idleTimer: ReturnType<typeof setTimeout> | null;
    subscribers: Set<(scrolling: boolean) => void>;
    handleScroll: () => void;
    handleUserIntent: () => void;
    handleWheel: (event: WheelEvent) => void;
    expectedProgrammaticScrollTop: number | null;
    wheelDirection: -1 | 0 | 1;
    lastWheelDelta: number;
    wheelStepPending: boolean;
    lastWheelAt: number;
    stabilizationFrame: number | null;
    stabilizationAnchor: HTMLElement | null;
    stabilizationAnchorTop: number;
    stabilizationUntil: number;
    guardReferences: number;
    cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const panelStates = new WeakMap<HTMLElement, PanelScrollState>();

function ensurePanelState(panel: HTMLElement): PanelScrollState {
    const existing = panelStates.get(panel);
    if (existing) {
        if (existing.cleanupTimer) {
            clearTimeout(existing.cleanupTimer);
            existing.cleanupTimer = null;
        }
        return existing;
    }
    const state: PanelScrollState = {
        lastScrollTop: panel.scrollTop,
        userScrollVersion: 0,
        scrolling: false,
        idleTimer: null,
        subscribers: new Set(),
        handleScroll: () => undefined,
        handleUserIntent: () => undefined,
        handleWheel: () => undefined,
        expectedProgrammaticScrollTop: null,
        wheelDirection: 0,
        lastWheelDelta: 0,
        wheelStepPending: false,
        lastWheelAt: 0,
        stabilizationFrame: null,
        stabilizationAnchor: null,
        stabilizationAnchorTop: 0,
        stabilizationUntil: 0,
        guardReferences: 0,
        cleanupTimer: null
    };
    const cancelStabilization = () => {
        if (state.stabilizationFrame !== null) cancelAnimationFrame(state.stabilizationFrame);
        state.stabilizationFrame = null;
        state.stabilizationAnchor = null;
        state.stabilizationUntil = 0;
    };
    const findStabilizationAnchor = () => {
        const panelRect = panel.getBoundingClientRect();
        const targetY = panelRect.top + Math.min(120, panelRect.height / 4);
        const nearestFor = (selector: string) => {
            let nearest: { element: HTMLElement; distance: number } | null = null;
            panel.querySelectorAll<HTMLElement>(selector).forEach(element => {
                const rect = element.getBoundingClientRect();
                if (rect.bottom <= panelRect.top || rect.top >= panelRect.bottom || rect.height <= 0) return;
                const distance = Math.abs(rect.top - targetY);
                if (!nearest || distance < nearest.distance) nearest = { element, distance };
            });
            return nearest?.element ?? null;
        };
        // Embedded titles are React-owned and survive CodeMirror's viewport
        // line recycling, so prefer them over ordinary .cm-line nodes.
        return nearestFor('[data-embed-nav-title="true"]') ?? nearestFor('.cm-line');
    };
    const beginStabilization = () => {
        cancelStabilization();
        const anchor = findStabilizationAnchor();
        if (!anchor) return;
        state.stabilizationAnchor = anchor;
        state.stabilizationAnchorTop = anchor.getBoundingClientRect().top;
        state.stabilizationUntil = performance.now() + 700;
        const stabilize = () => {
            const currentAnchor = state.stabilizationAnchor;
            if (!currentAnchor?.isConnected || state.scrolling || performance.now() > state.stabilizationUntil) {
                cancelStabilization();
                return;
            }
            const currentTop = currentAnchor.getBoundingClientRect().top;
            const visualDelta = currentTop - state.stabilizationAnchorTop;
            if (Math.abs(visualDelta) > 0.5) {
                const target = Math.max(
                    0,
                    Math.min(panel.scrollTop + visualDelta, panel.scrollHeight - panel.clientHeight)
                );
                if (Math.abs(target - panel.scrollTop) > 0.5) {
                    state.expectedProgrammaticScrollTop = target;
                    panel.scrollTop = target;
                    state.lastScrollTop = panel.scrollTop;
                }
            }
            state.stabilizationFrame = requestAnimationFrame(stabilize);
        };
        state.stabilizationFrame = requestAnimationFrame(stabilize);
    };
    state.handleUserIntent = () => {
        cancelStabilization();
        state.userScrollVersion += 1;
        state.expectedProgrammaticScrollTop = null;
        state.wheelDirection = 0;
        state.lastWheelDelta = 0;
        state.wheelStepPending = false;
    };
    state.handleWheel = event => {
        cancelStabilization();
        state.userScrollVersion += 1;
        state.expectedProgrammaticScrollTop = null;
        state.wheelDirection = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0;
        state.lastWheelDelta = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
            ? event.deltaY
            : event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 24 : panel.clientHeight);
        state.wheelStepPending = true;
        state.lastWheelAt = performance.now();
    };
    state.handleScroll = () => {
        const nextScrollTop = panel.scrollTop;
        const scrollDelta = nextScrollTop - state.lastScrollTop;
        const wasExpectedProgrammaticScroll = state.expectedProgrammaticScrollTop !== null
            && Math.abs(nextScrollTop - state.expectedProgrammaticScrollTop) <= 0.5;
        if (wasExpectedProgrammaticScroll) {
            state.expectedProgrammaticScrollTop = null;
            state.lastScrollTop = nextScrollTop;
            return;
        }
        // Embedded heights settle only after the 180 ms scroll-idle boundary.
        // Keep the gesture direction through that first measurement pass so a
        // delayed browser/CodeMirror anchor correction cannot visibly reverse
        // the viewport after the user's fingers have just stopped. Pointer and
        // keyboard intent clear this guard immediately in handleUserIntent.
        const wheelIsActive = performance.now() - state.lastWheelAt <= 700;
        // CodeMirror can redistribute measured block heights without changing
        // the document's total height. Chromium may surface that as a scroll
        // step opposite to the current wheel/trackpad gesture. Reject only
        // that contradictory step; a new wheel event immediately changes the
        // allowed direction, and keyboard/programmatic movement is untouched.
        if (wheelIsActive && state.wheelDirection !== 0 && Math.abs(scrollDelta) > 0.5
            && Math.sign(scrollDelta) !== state.wheelDirection) {
            state.expectedProgrammaticScrollTop = state.lastScrollTop;
            panel.scrollTop = state.lastScrollTop;
            return;
        }
        // A viewport remeasurement may be delivered as one large scroll in
        // the *same* direction as the gesture (for example -415 after a -28
        // wheel step). Direction-only protection cannot distinguish that from
        // intent. Bound a single event to the active wheel step when it is far
        // outside any plausible browser multiplier.
        const maximumPlausibleWheelStep = Math.max(120, Math.abs(state.lastWheelDelta) * 3);
        if (wheelIsActive && state.wheelDirection !== 0 && Math.abs(scrollDelta) > maximumPlausibleWheelStep) {
            // If an ordinary scroll event already consumed this wheel step,
            // lastScrollTop is the intended position and the later large event
            // is purely a layout correction. If it has not, preserve exactly
            // one wheel step while rejecting the extra displacement.
            const intended = Math.max(
                0,
                Math.min(
                    state.lastScrollTop + (state.wheelStepPending ? state.lastWheelDelta : 0),
                    panel.scrollHeight - panel.clientHeight
                )
            );
            state.wheelStepPending = false;
            state.expectedProgrammaticScrollTop = intended;
            panel.scrollTop = intended;
            return;
        }
        state.expectedProgrammaticScrollTop = null;
        if (wheelIsActive && state.wheelDirection !== 0 && Math.abs(scrollDelta) > 0.5
            && Math.sign(scrollDelta) === state.wheelDirection) {
            // A plausible movement in the wheel direction consumes the step
            // even if an older anchor transaction happened to predict the
            // same position.
            state.wheelStepPending = false;
        }
        // Scroll events caused by an anchor correction must not invalidate that
        // same transaction. Every other movement is user or browser intent and
        // cancels pending corrections in either direction.
        if (!wasExpectedProgrammaticScroll && Math.abs(nextScrollTop - state.lastScrollTop) > 0.5) {
            state.userScrollVersion += 1;
            state.wheelStepPending = false;
        }
        state.lastScrollTop = nextScrollTop;
        if (!state.scrolling) {
            state.scrolling = true;
            state.subscribers.forEach(subscriber => subscriber(true));
        }
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => {
            state.scrolling = false;
            state.idleTimer = null;
            beginStabilization();
            state.subscribers.forEach(subscriber => subscriber(false));
        }, 180);
    };
    panel.addEventListener("scroll", state.handleScroll, { passive: true });
    panel.addEventListener("wheel", state.handleWheel, { passive: true, capture: true });
    panel.addEventListener("touchmove", state.handleUserIntent, { passive: true, capture: true });
    panel.addEventListener("pointerdown", state.handleUserIntent, { passive: true, capture: true });
    panel.addEventListener("keydown", state.handleUserIntent, { capture: true });
    panelStates.set(panel, state);
    return state;
}

function releasePanelState(panel: HTMLElement, state: PanelScrollState) {
    if (state.subscribers.size > 0 || state.guardReferences > 0) return;
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    // CodeMirror may remove every embedded widget for only a few frames while
    // it swaps viewport ranges. Preserve the panel's active-scroll state across
    // that gap; otherwise newly mounted widgets believe the same gesture is
    // idle and overwrite their settled height with partial geometry.
    state.cleanupTimer = setTimeout(() => {
        state.cleanupTimer = null;
        if (state.subscribers.size > 0 || state.guardReferences > 0) return;
        panel.removeEventListener("scroll", state.handleScroll);
        panel.removeEventListener("wheel", state.handleWheel, true);
        panel.removeEventListener("touchmove", state.handleUserIntent, true);
        panel.removeEventListener("pointerdown", state.handleUserIntent, true);
        panel.removeEventListener("keydown", state.handleUserIntent, true);
        if (state.idleTimer) clearTimeout(state.idleTimer);
        if (state.stabilizationFrame !== null) cancelAnimationFrame(state.stabilizationFrame);
        state.stabilizationFrame = null;
        state.stabilizationAnchor = null;
        state.stabilizationUntil = 0;
        panelStates.delete(panel);
    }, 1500);
}

export function subscribeToEmbeddedPanelScroll(panel: HTMLElement, subscriber: (scrolling: boolean) => void) {
    const state = ensurePanelState(panel);
    state.subscribers.add(subscriber);
    subscriber(state.scrolling);
    return () => {
        state.subscribers.delete(subscriber);
        releasePanelState(panel, state);
    };
}

export function registerEmbeddedPanelScrollGuard(panel: HTMLElement) {
    const state = ensurePanelState(panel);
    state.guardReferences += 1;
    return () => {
        state.guardReferences = Math.max(0, state.guardReferences - 1);
        releasePanelState(panel, state);
    };
}

export function getEmbeddedPanelScrollVersion(panel: HTMLElement) {
    return ensurePanelState(panel).userScrollVersion;
}

export function isEmbeddedPanelScrolling(panel: HTMLElement) {
    const state = panelStates.get(panel);
    if (!state) return false;
    // A wheel event can make CodeMirror recycle viewport DOM before the
    // browser emits the corresponding scroll event. Treat that short intent
    // window as active scrolling too, so destroy/remount measurements cannot
    // publish partial nested geometry between those two events.
    return state.scrolling || performance.now() - state.lastWheelAt <= 700;
}

export function setEmbeddedPanelScrollTop(panel: HTMLElement, scrollTop: number) {
    const state = ensurePanelState(panel);
    const boundedScrollTop = Math.max(0, Math.min(scrollTop, panel.scrollHeight - panel.clientHeight));
    state.expectedProgrammaticScrollTop = boundedScrollTop;
    panel.scrollTop = boundedScrollTop;
    state.lastScrollTop = panel.scrollTop;
}
