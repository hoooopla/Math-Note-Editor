import React, { useState, useEffect } from 'react';
import { useStore } from '../store';
import { X, Plus, Trash2 } from 'lucide-react';

interface MacroSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function MacroSettingsModal({ isOpen, onClose }: MacroSettingsModalProps) {
    const { macros, saveMacros } = useStore();
    const [localMacros, setLocalMacros] = useState<Array<{key: string, value: string}>>([]);

    useEffect(() => {
        if (isOpen) {
            setLocalMacros(Object.entries(macros).map(([key, value]) => ({ key, value })));
        }
    }, [isOpen, macros]);

    if (!isOpen) return null;

    const handleSave = () => {
        const newMacros: Record<string, string> = {};
        for (const m of localMacros) {
            if (m.key.trim()) {
                const key = m.key.trim().startsWith('\\') ? m.key.trim() : `\\${m.key.trim()}`;
                newMacros[key] = m.value.trim();
            }
        }
        saveMacros(newMacros);
        onClose();
    };

    const addMacro = () => {
        setLocalMacros([...localMacros, { key: '', value: '' }]);
    };

    const removeMacro = (index: number) => {
        setLocalMacros(localMacros.filter((_, i) => i !== index));
    };

    const updateMacro = (index: number, field: 'key' | 'value', val: string) => {
        const newMacros = [...localMacros];
        newMacros[index][field] = val;
        setLocalMacros(newMacros);
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-surface rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col border border-outline">
                <div className="flex justify-between items-center p-4 border-b border-outline">
                    <h2 className="text-lg font-bold text-primary">Math Macros</h2>
                    <button onClick={onClose} className="p-1 text-secondary hover:text-primary transition-colors">
                        <X size={20} />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {localMacros.length === 0 ? (
                        <p className="text-sm text-secondary text-center py-4">No macros configured. Add one below.</p>
                    ) : (
                        <div className="space-y-4">
                            <p className="text-xs text-secondary mt-1 mb-3">
                                Tip: You can use arguments like <code>#1</code>, <code>#2</code> in the value. For example, key <code>{"\\E"}</code> and value <code>{"\\mathbb{E}\\left[ #1 \\right]"}</code> lets you type <code>{"\\E{X}"}</code>.
                            </p>
                            {localMacros.map((macro, i) => (
                                <div key={i} className="flex gap-2 items-center">
                                    <input
                                        type="text"
                                        placeholder="\macro"
                                        value={macro.key}
                                        onChange={(e) => updateMacro(i, 'key', e.target.value)}
                                        className="flex-1 bg-base border border-outline rounded px-2 py-1.5 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                    />
                                    <span>=</span>
                                    <input
                                        type="text"
                                        placeholder="\mathbb{R}"
                                        value={macro.value}
                                        onChange={(e) => updateMacro(i, 'value', e.target.value)}
                                        className="flex-1 bg-base border border-outline rounded px-2 py-1.5 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                    />
                                    <button
                                        onClick={() => removeMacro(i)}
                                        className="p-1.5 text-secondary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <button
                        onClick={addMacro}
                        className="w-full py-2 flex items-center justify-center gap-2 text-sm text-accent hover:bg-accent/10 border border-transparent hover:border-accent/20 rounded transition-colors"
                    >
                        <Plus size={16} />
                        Add Macro
                    </button>
                </div>
                <div className="p-4 border-t border-outline flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-primary hover:bg-accent/10 rounded transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="px-4 py-2 text-sm bg-accent text-white font-medium hover:bg-accent/90 rounded transition-colors shadow"
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
