export interface EmbeddedLayoutDependency {
    id: string;
    title: string;
    // null means that this body has not loaded, not that it is empty.
    content: string | null;
}

/** Loading may refine geometry; edits, toggles and renamed targets invalidate it. */
export function isEmbeddedLayoutHydration(
    previous: Record<string, EmbeddedLayoutDependency>,
    current: Record<string, EmbeddedLayoutDependency>
) {
    return Object.entries(previous).every(([label, before]) => {
        const after = current[label];
        return !!after && before.id === after.id && before.title === after.title &&
            (before.content === null || before.content === after.content);
    });
}
