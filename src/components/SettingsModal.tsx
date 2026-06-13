import React, { useState, useEffect } from 'react';
import { useStore } from '../store';
import { X, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { settings, saveSettings } = useStore();
    const [activeTab, setActiveTab] = useState<'macros' | 'commands' | 'text'>('macros');
    const [localMacros, setLocalMacros] = useState<Array<{key: string, value: string}>>([]);
    const [localCommands, setLocalCommands] = useState<string[]>([]);
    const [localTextCommands, setLocalTextCommands] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setLocalMacros(Object.entries(settings.macros || {}).map(([key, value]) => ({ key, value })));
            setLocalCommands([...(settings.customCommands || [])]);
            setLocalTextCommands([...(settings.textCommands || [])]);
        }
    }, [isOpen, settings]);

    if (!isOpen) return null;

    const handleSave = () => {
        const newMacros: Record<string, string> = {};
        for (const m of localMacros) {
            if (m.key.trim()) {
                const key = m.key.trim().startsWith('\\') ? m.key.trim() : `\\${m.key.trim()}`;
                newMacros[key] = m.value.trim();
            }
        }
        
        const newCommands = localCommands
            .map(c => c.trim())
            .filter(c => c.length > 0)
            .map(c => c.startsWith('\\') ? c : `\\${c}`);

        const newTextCommands = localTextCommands
            .map(c => c.trim())
            .filter(c => c.length > 0);
            
        saveSettings({
            ...settings,
            macros: newMacros,
            customCommands: newCommands,
            textCommands: newTextCommands
        });
        onClose();
    };

    const addMacro = () => setLocalMacros([...localMacros, { key: '', value: '' }]);
    const removeMacro = (index: number) => setLocalMacros(localMacros.filter((_, i) => i !== index));
    const updateMacro = (index: number, field: 'key' | 'value', val: string) => {
        const newMacros = [...localMacros];
        newMacros[index][field] = val;
        setLocalMacros(newMacros);
    };

    const addCommand = () => setLocalCommands([...localCommands, '']);
    const removeCommand = (index: number) => setLocalCommands(localCommands.filter((_, i) => i !== index));
    const updateCommand = (index: number, val: string) => {
        const newCommands = [...localCommands];
        newCommands[index] = val;
        setLocalCommands(newCommands);
    };
    const moveCommand = (index: number, dir: -1 | 1) => {
        if (index + dir < 0 || index + dir >= localCommands.length) return;
        const newCommands = [...localCommands];
        const temp = newCommands[index];
        newCommands[index] = newCommands[index + dir];
        newCommands[index + dir] = temp;
        setLocalCommands(newCommands);
    };

    const addTextCommand = () => setLocalTextCommands([...localTextCommands, '']);
    const removeTextCommand = (index: number) => setLocalTextCommands(localTextCommands.filter((_, i) => i !== index));
    const updateTextCommand = (index: number, val: string) => {
        const newTextCommands = [...localTextCommands];
        newTextCommands[index] = val;
        setLocalTextCommands(newTextCommands);
    };
    const moveTextCommand = (index: number, dir: -1 | 1) => {
        if (index + dir < 0 || index + dir >= localTextCommands.length) return;
        const newTextCommands = [...localTextCommands];
        const temp = newTextCommands[index];
        newTextCommands[index] = newTextCommands[index + dir];
        newTextCommands[index + dir] = temp;
        setLocalTextCommands(newTextCommands);
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-surface rounded-xl shadow-xl w-full max-w-4xl h-[75vh] flex flex-col border border-outline overflow-hidden">
                <div className="flex justify-between items-center p-4 border-b border-outline">
                    <h2 className="text-lg font-bold text-primary">Editor Settings</h2>
                    <button onClick={onClose} className="p-1 text-secondary hover:text-primary transition-colors">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="flex flex-1 overflow-hidden">
                    {/* Left Sidebar */}
                    <div className="w-48 md:w-64 border-r border-outline flex flex-col p-3 space-y-1 bg-base/30">
                        <button 
                            className={`px-3 py-2.5 text-sm font-medium rounded-lg text-left transition-colors ${activeTab === 'macros' ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-outline/50 hover:text-primary'}`}
                            onClick={() => setActiveTab('macros')}
                        >
                            Math Macros
                        </button>
                        <button 
                            className={`px-3 py-2.5 text-sm font-medium rounded-lg text-left transition-colors ${activeTab === 'commands' ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-outline/50 hover:text-primary'}`}
                            onClick={() => setActiveTab('commands')}
                        >
                            Autocomplete
                        </button>
                        <button 
                            className={`px-3 py-2.5 text-sm font-medium rounded-lg text-left transition-colors ${activeTab === 'text' ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-outline/50 hover:text-primary'}`}
                            onClick={() => setActiveTab('text')}
                        >
                            Text Autocomplete
                        </button>
                    </div>

                    {/* Right Content */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-6">
                        {activeTab === 'macros' && (
                            <div className="max-w-2xl">
                                <h3 className="text-base font-semibold text-primary mb-1">Math Macros</h3>
                                <p className="text-sm text-secondary mb-6">
                                    Tip: You can use arguments like <code>#1</code>, <code>#2</code> in the value. For example, key <code>{"\\E"}</code> and value <code>{"\\mathbb{E}\\left[ #1 \\right]"}</code> lets you type <code>{"\\E{X}"}</code>.
                                </p>
                                {localMacros.length === 0 ? (
                                    <div className="text-center py-10 bg-base border border-outline border-dashed rounded-lg">
                                        <p className="text-sm text-secondary">No macros configured.</p>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {localMacros.map((macro, i) => (
                                            <div key={i} className="flex gap-2 items-center">
                                                <input
                                                    type="text"
                                                    placeholder="\macro"
                                                    value={macro.key}
                                                    onChange={(e) => updateMacro(i, 'key', e.target.value)}
                                                    className="w-1/3 bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent min-w-0"
                                                />
                                                <span className="text-secondary">=</span>
                                                <input
                                                    type="text"
                                                    placeholder="\mathbb{R}"
                                                    value={macro.value}
                                                    onChange={(e) => updateMacro(i, 'value', e.target.value)}
                                                    className="flex-1 bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent min-w-0"
                                                />
                                                <button
                                                    onClick={() => removeMacro(i)}
                                                    className="p-2 flex-shrink-0 text-secondary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                                >
                                                    <Trash2 size={18} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <button
                                    onClick={addMacro}
                                    className="w-full py-2.5 flex items-center justify-center gap-2 text-sm font-medium text-accent hover:bg-accent/10 border border-transparent hover:border-accent/20 rounded-lg transition-colors mt-4"
                                >
                                    <Plus size={16} />
                                    Add Macro
                                </button>
                            </div>
                        )}

                        {activeTab === 'commands' && (
                            <div className="max-w-2xl">
                                <h3 className="text-base font-semibold text-primary mb-1">Autocomplete Commands</h3>
                                <p className="text-sm text-secondary mb-6">
                                    Define custom LaTeX commands to appear in autocompletion suggestions.
                                </p>
                                {localCommands.length === 0 ? (
                                    <div className="text-center py-10 bg-base border border-outline border-dashed rounded-lg">
                                        <p className="text-sm text-secondary">No custom commands configured.</p>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {localCommands.map((cmd, i) => (
                                            <div key={i} className="flex gap-2 items-center">
                                                <div className="flex-1 relative">
                                                    <input
                                                        type="text"
                                                        placeholder="\mycommand"
                                                        value={cmd}
                                                        onChange={(e) => updateCommand(i, e.target.value)}
                                                        className="w-full bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    />
                                                </div>
                                                <button
                                                    onClick={() => moveCommand(i, -1)}
                                                    disabled={i === 0}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowUp size={16} />
                                                </button>
                                                <button
                                                    onClick={() => moveCommand(i, 1)}
                                                    disabled={i === localCommands.length - 1}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowDown size={16} />
                                                </button>
                                                <button
                                                    onClick={() => removeCommand(i)}
                                                    className="p-1.5 text-secondary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <button
                                    onClick={addCommand}
                                    className="w-full py-2.5 flex items-center justify-center gap-2 text-sm font-medium text-accent hover:bg-accent/10 border border-transparent hover:border-accent/20 rounded-lg transition-colors mt-4"
                                >
                                    <Plus size={16} />
                                    Add Command
                                </button>
                            </div>
                        )}

                        {activeTab === 'text' && (
                            <div className="max-w-2xl">
                                <h3 className="text-base font-semibold text-primary mb-1">Text Autocomplete</h3>
                                <p className="text-sm text-secondary mb-6">
                                    Commands that will appear in normal text editing when you type <code>\</code>.
                                </p>
                                {localTextCommands.length === 0 ? (
                                    <div className="text-center py-10 bg-base border border-outline border-dashed rounded-lg">
                                        <p className="text-sm text-secondary">No text commands configured.</p>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {localTextCommands.map((cmd, i) => (
                                            <div key={i} className="flex gap-2 items-center">
                                                <div className="flex-1 relative">
                                                    <input
                                                        type="text"
                                                        placeholder="command"
                                                        value={cmd}
                                                        onChange={(e) => updateTextCommand(i, e.target.value)}
                                                        className="w-full bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    />
                                                </div>
                                                <button
                                                    onClick={() => moveTextCommand(i, -1)}
                                                    disabled={i === 0}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowUp size={16} />
                                                </button>
                                                <button
                                                    onClick={() => moveTextCommand(i, 1)}
                                                    disabled={i === localTextCommands.length - 1}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowDown size={16} />
                                                </button>
                                                <button
                                                    onClick={() => removeTextCommand(i)}
                                                    className="p-1.5 text-secondary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <button
                                    onClick={addTextCommand}
                                    className="w-full py-2.5 flex items-center justify-center gap-2 text-sm font-medium text-accent hover:bg-accent/10 border border-transparent hover:border-accent/20 rounded-lg transition-colors mt-4"
                                >
                                    <Plus size={16} />
                                    Add Text Command
                                </button>
                            </div>
                        )}
                    </div>
                </div>
                
                <div className="p-4 border-t border-outline flex justify-end gap-3 bg-base/50">
                    <button
                        onClick={onClose}
                        className="px-5 py-2 text-sm text-primary hover:bg-outline rounded-lg transition-colors font-medium"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="px-5 py-2 text-sm bg-accent text-white font-medium hover:bg-accent/90 rounded-lg transition-colors shadow-sm"
                    >
                        Save Settings
                    </button>
                </div>
            </div>
        </div>
    );
}
