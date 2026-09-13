import { useEffect, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { useStore } from '../store';
import type { WorkspaceBackup } from '../store/api';

function readableSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupRecovery() {
    const backendMode = useStore(state => state.backendMode);
    const listBackups = useStore(state => state.listBackups);
    const restoreBackup = useStore(state => state.restoreBackup);
    const [backups, setBackups] = useState<WorkspaceBackup[]>([]);
    const [loading, setLoading] = useState(true);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const refresh = async () => {
        setLoading(true);
        try {
            setBackups(await listBackups());
            setMessage(null);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        } finally { setLoading(false); }
    };

    useEffect(() => { void refresh(); }, [backendMode]);

    const restore = async (backup: WorkspaceBackup) => {
        if (!window.confirm(`Restore the backup of “${backup.path}”?\n\nThe current version will become the backup, so you can reverse this action.`)) return;
        setRestoring(backup.path);
        setMessage(null);
        try {
            await restoreBackup(backup.path);
            await refresh();
            setMessage(`Restored ${backup.path}. Its previous current version is now the backup.`);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        } finally { setRestoring(null); }
    };

    const canRestore = backendMode === 'server' || backendMode === 'local';
    return <div className="mt-5 rounded-lg border border-outline bg-base/40 p-4">
        <div className="flex items-start justify-between gap-3">
            <div>
                <h4 className="flex items-center gap-2 text-sm font-semibold text-primary"><History size={16}/>Backup Recovery</h4>
                <p className="mt-1 text-xs text-secondary">Restore the previous saved version of a note, asset, or workspace setting. Restoring swaps the current and backup versions, so it can be reversed.</p>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh backup list" className="rounded p-2 text-secondary hover:bg-outline/40 hover:text-primary disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''}/></button>
        </div>
        {message && <p className="mt-3 rounded border border-outline bg-surface px-3 py-2 text-xs text-primary" role="status">{message}</p>}
        {!canRestore ? <p className="mt-4 text-xs text-secondary">Open this workspace with write access to restore backups.</p>
            : loading ? <p className="mt-4 text-xs text-secondary">Loading backups…</p>
            : backups.length === 0 ? <p className="mt-4 text-xs text-secondary">No backups are available yet. A backup appears after an existing file is changed.</p>
            : <div className="mt-4 max-h-64 space-y-2 overflow-y-auto" aria-label="Available backups">
                {backups.map(backup => <div key={backup.path} className="flex items-center justify-between gap-3 rounded-md border border-outline bg-surface px-3 py-2">
                    <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-primary" title={backup.path}>{backup.path}</p>
                        <p className="mt-0.5 text-[11px] text-secondary">{new Date(backup.modifiedAt).toLocaleString()} · {readableSize(backup.size)}</p>
                    </div>
                    <button type="button" onClick={() => void restore(backup)} disabled={restoring !== null} className="shrink-0 rounded-md border border-outline px-3 py-1.5 text-xs font-medium text-primary hover:bg-outline/40 disabled:opacity-50">
                        {restoring === backup.path ? 'Restoring…' : 'Restore'}
                    </button>
                </div>)}
            </div>}
    </div>;
}
