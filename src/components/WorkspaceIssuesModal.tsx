import { useState } from 'react';
import { AlertTriangle, FileWarning, X } from "lucide-react";
import { useStore } from "../store";

export function WorkspaceIssuesModal({ onClose }: { onClose: () => void }) {
    const issues = useStore(state => state.workspaceIssues);
    const repairDuplicateLabel = useStore(state => state.repairDuplicateLabel);
    const canRepair = useStore(state => state.backendMode !== "viewer");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [label, setLabel] = useState('');
    const [error, setError] = useState<string | null>(null);

    const beginRepair = (blockId: string, currentLabel: string) => {
        setEditingId(blockId);
        setLabel(`${currentLabel}-renamed`);
        setError(null);
    };

    const saveRepair = async () => {
        if (!editingId) return;
        const repaired = await repairDuplicateLabel(editingId, label);
        if (!repaired) setError('Choose a unique, valid label and try again.');
    };

    return <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="workspace-issues-title">
        <div className="flex max-h-[85vh] w-[min(94vw,760px)] flex-col overflow-hidden rounded-xl border border-amber-400/40 bg-surface shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-outline px-5 py-4">
                <div className="flex gap-3">
                    <AlertTriangle className="mt-0.5 shrink-0 text-amber-300" size={22}/>
                    <div>
                        <h2 id="workspace-issues-title" className="text-lg font-semibold text-primary">Duplicate labels need attention</h2>
                        <p className="mt-1 text-sm text-secondary">{canRepair ? "Choose one block in each group to keep the shared label, then give every other block a unique label." : "Reconnect this workspace with write access to repair these labels."}</p>
                    </div>
                </div>
                <button onClick={onClose} className="rounded p-1 text-secondary hover:bg-outline hover:text-primary" aria-label="Close workspace issues"><X size={18}/></button>
            </div>
            <div className="overflow-y-auto p-5">
                <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                    Editing is paused for affected blocks so links cannot silently resolve to the wrong note. Existing links will continue to point to whichever block keeps the original label; they are not reassigned automatically.
                </div>
                <div className="space-y-4">
                    {issues.map(issue => <section key={issue.label} className="rounded-lg border border-outline bg-base/60 p-4">
                        <div className="mb-3 font-mono text-sm font-semibold text-amber-300">{issue.label}</div>
                        <div className="space-y-2">
                            {issue.blocks.map(block => <div key={block.id} className="flex items-center justify-between gap-3 rounded border border-outline bg-surface px-3 py-2">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-primary">{block.title || "Untitled block"}</div>
                                    <div className="mt-0.5 truncate font-mono text-[11px] text-secondary" title={block.fileName || block.id}>{block.fileName || block.id}</div>
                                </div>
                                {canRepair && <button onClick={() => beginRepair(block.id, block.label)} className="shrink-0 rounded-md border border-amber-400/40 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-400/10">
                                    Open to rename
                                </button>}
                            </div>)}
                            {editingId && issue.blocks.some(block => block.id === editingId) && <div className="mt-3 rounded-md border border-amber-400/30 bg-surface p-3">
                                <label className="text-xs font-medium text-primary" htmlFor={`repair-label-${editingId}`}>New unique label</label>
                                <div className="mt-2 flex gap-2">
                                    <input id={`repair-label-${editingId}`} aria-label="Block label" autoFocus value={label} onChange={event => { setLabel(event.target.value); setError(null); }} onKeyDown={event => { if (event.key === 'Enter') void saveRepair(); }} className="min-w-0 flex-1 rounded border border-outline bg-base px-3 py-2 font-mono text-sm text-primary outline-none focus:border-accent"/>
                                    <button aria-label="Save block metadata" onClick={() => void saveRepair()} className="rounded bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent/90">Save</button>
                                </div>
                                {error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}
                            </div>}
                        </div>
                    </section>)}
                </div>
            </div>
            <div className="flex items-center justify-between border-t border-outline px-5 py-3 text-xs text-secondary">
                <span className="flex items-center gap-1.5"><FileWarning size={14}/>{issues.length} duplicate label {issues.length === 1 ? "group" : "groups"}</span>
                <button onClick={onClose} className="rounded px-3 py-1.5 hover:bg-outline hover:text-primary">Review later</button>
            </div>
        </div>
    </div>;
}
