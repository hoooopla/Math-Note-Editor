import { StateEffect } from "@codemirror/state";

export interface EmbeddedObjectSelection {
    from: number;
    to: number;
    edge: "before" | "after";
}

export const setEmbeddedObjectSelection = StateEffect.define<EmbeddedObjectSelection | null>();
