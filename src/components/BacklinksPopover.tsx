import React, { useEffect, useMemo, useRef } from "react";
import { ExternalLink, Link2, X } from "lucide-react";
import { findBacklinkOccurrences } from "../lib/backlinks";
import { useStore } from "../store";
import { MathTitle } from "./MathTitle";

interface BacklinksPopoverProps {
    targetLabel: string;
    sourceIds: string[];
    onClose: () => void;
}

export function BacklinksPopover({ targetLabel, sourceIds, onClose }: BacklinksPopoverProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const blocksById = useStore(state => state.blocksById);
    const sources = useMemo(() => {
        return sourceIds.map(id => blocksById[id]).filter(Boolean);
    }, [sourceIds, blocksById]);
    const loadBlockContent = useStore(state => state.loadBlockContent);

    useEffect(() => {
        const missing = sourceIds.filter(id => useStore.getState().blocksById[id]?.content === undefined);
        void Promise.all(missing.map(id => loadBlockContent(id)));
    }, [sourceIds, loadBlockContent]);

    useEffect(() => {
        const closeOnPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) onClose();
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("pointerdown", closeOnPointerDown);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnPointerDown);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [onClose]);

    const rows = useMemo(() => sources.map(source => ({
        source,
        occurrences: source.content === undefined
            ? null
            : findBacklinkOccurrences(source.content, source.label, targetLabel)
    })), [sources, targetLabel]);

    return (
        <div
            ref={rootRef}
            role="dialog"
            aria-label={`Backlinks to ${targetLabel}`}
            data-testid="backlinks-popover"
            className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] isolate overflow-hidden rounded-lg border border-outline bg-surface opacity-100 text-left font-sans shadow-2xl"
            style={{ backgroundColor: "var(--color-surface, #1a1d23)" }}
            onClick={event => event.stopPropagation()}
        >
            <div className="flex items-center gap-2 border-b border-outline px-3 py-2">
                <Link2 size={14} className="text-accent" aria-hidden="true" />
                <span className="text-sm font-semibold text-primary">Backlinks</span>
                <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">{sourceIds.length}</span>
                <button className="ml-auto rounded p-1 text-secondary hover:bg-outline hover:text-primary" onClick={onClose} aria-label="Close backlinks">
                    <X size={14} />
                </button>
            </div>
            <div className="max-h-80 overflow-y-auto p-1.5">
                {rows.length === 0 && (
                    <div className="px-3 py-5 text-center text-xs text-secondary">No blocks link here yet.</div>
                )}
                {rows.map(({ source, occurrences }) => {
                    const count = occurrences?.length || 0;
                    return (
                        <button
                            key={source.id}
                            type="button"
                            data-testid={`backlink-source-${source.id}`}
                            className="group/backlink block w-full rounded-md px-2.5 py-2 text-left hover:bg-accent/10 focus:bg-accent/10 focus:outline-none"
                            onClick={() => {
                                useStore.getState().openBlockNextToActive(source.id);
                                onClose();
                            }}
                        >
                            <div className="flex min-w-0 items-center gap-2">
                                <MathTitle text={source.title || source.label} className="min-w-0 flex-1 truncate text-sm font-semibold text-primary" />
                                {count > 1 && <span className="shrink-0 text-[10px] text-secondary">{count} mentions</span>}
                                <ExternalLink size={12} className="shrink-0 text-secondary opacity-0 group-hover/backlink:opacity-100" aria-hidden="true" />
                            </div>
                            <div className="truncate font-mono text-[10px] text-secondary" title={source.label}>{source.label}</div>
                            {occurrences === null ? (
                                <div className="mt-1 animate-pulse text-xs text-secondary/70">Loading excerpt…</div>
                            ) : occurrences[0] ? (
                                <div className="mt-1 line-clamp-2 break-words text-xs leading-4 text-secondary" title={occurrences[0].line}>
                                    {occurrences[0].line}
                                </div>
                            ) : (
                                <div className="mt-1 text-xs italic text-secondary/70">Reference changed</div>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
