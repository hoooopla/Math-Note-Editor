import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { X, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { BackupRecovery } from './BackupRecovery';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MATH_COMMAND = /^\\[A-Za-z]+(?:\{[^{}\n]*\})*$/;

const normalizeMathCommand = (value: string) => {
    const trimmed = value.trim();
    return trimmed.startsWith('\\') ? trimmed : `\\${trimmed}`;
};

const isValidShortcut = (value: string) => {
    const parts = value.toLowerCase().split('+').map(part => part.trim()).filter(Boolean);
    if (parts.length === 1 && /^f(?:[1-9]|1[0-2])$/.test(parts[0])) return true;
    const modifiers = parts.slice(0, -1);
    const key = parts.at(-1) || '';
    return parts.length >= 2
        && modifiers.every(modifier => ['ctrl', 'meta', 'cmd', 'mod', 'shift', 'alt'].includes(modifier))
        && modifiers.some(modifier => ['ctrl', 'meta', 'cmd', 'mod'].includes(modifier))
        && new Set(modifiers).size === modifiers.length
        && /^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|tab|enter|space|escape|backspace|delete|arrow(?:up|down|left|right)|\/)$/.test(key);
};

const settingsTabs = [
    { id: 'general', label: 'General Setting' },
    { id: 'keyboard', label: 'Keyboard Shortcuts' },
    { id: 'macros', label: 'Math Macros' },
    { id: 'commands', label: 'Autocomplete' },
    { id: 'text', label: 'Text Autocomplete' },
    { id: 'embedded', label: 'Embedded Blocks' },
    { id: 'colors', label: 'Math Visual' }
] as const;

type SettingsTab = typeof settingsTabs[number]['id'];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const settings = useStore(state => state.settings);
    const saveSettings = useStore(state => state.saveSettings);
    const backendMode = useStore(state => state.backendMode);
    const workspaceName = useStore(state => state.workspaceName);
    const connectLocalFS = useStore(state => state.connectLocalFS);
    const connectGoogleDrive = useStore(state => state.connectGoogleDrive);
    const disconnectGoogleDrive = useStore(state => state.disconnectGoogleDrive);
    const loadViewerFiles = useStore(state => state.loadViewerFiles);
    const persistenceError = useStore(state => state.persistenceError);
    const isLoadingFiles = useStore(state => state.isLoadingFiles);
    const dialogRef = useRef<HTMLDivElement>(null);
    const settingsFileRef = useRef<HTMLInputElement>(null);
    const viewerFolderRef = useRef<HTMLInputElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const [activeTab, setActiveTab] = useState<SettingsTab>('general');
    const [localMacros, setLocalMacros] = useState<Array<{key: string, value: string}>>([]);
    const [localCommands, setLocalCommands] = useState<string[]>([]);
    const [localTextCommands, setLocalTextCommands] = useState<string[]>([]);
    const [localSearchShortcut, setLocalSearchShortcut] = useState<string>('meta+k');
    const [localEditMetadataShortcut, setLocalEditMetadataShortcut] = useState<string>('f2');
    const [localGoToParentShortcut, setLocalGoToParentShortcut] = useState<string>('mod+shift+arrowup');
    const [localCloseTabShortcut, setLocalCloseTabShortcut] = useState<string>('mod+w');
    const [localReopenTabShortcut, setLocalReopenTabShortcut] = useState<string>('mod+shift+t');
    const [localNextTabShortcut, setLocalNextTabShortcut] = useState<string>('ctrl+tab');
    const [localPreviousTabShortcut, setLocalPreviousTabShortcut] = useState<string>('ctrl+shift+tab');
    const [workspacePath, setWorkspacePath] = useState<string | null>(null);
    const [importMessage, setImportMessage] = useState<string | null>(null);
    const [localMathHighlightColor, setLocalMathHighlightColor] = useState<string>('#d19a66');
    const [localInlineBlockColorFilled, setLocalInlineBlockColorFilled] = useState<string>('#a8b5c2');
    const [localInlineBlockColorEmpty, setLocalInlineBlockColorEmpty] = useState<string>('#FF997D');
    const [localInlineBlockTitleUnderlineOpacity, setLocalInlineBlockTitleUnderlineOpacity] = useState<number>(100);
    const [localInlineBlockIndentWidth, setLocalInlineBlockIndentWidth] = useState<number>(16);
    const [localStandoutBlockColorFilled, setLocalStandoutBlockColorFilled] = useState<string>('#a8b5c2');
    const [localStandoutBlockColorEmpty, setLocalStandoutBlockColorEmpty] = useState<string>('#FF997D');
    const [localStandoutBlockIndentWidth, setLocalStandoutBlockIndentWidth] = useState<number>(0);
    const [localStandoutTitlePaddingLeft, setLocalStandoutTitlePaddingLeft] = useState<number>(10);
    const [localStandoutTitlePaddingRight, setLocalStandoutTitlePaddingRight] = useState<number>(6);
    const [localStandoutTitlePaddingTop, setLocalStandoutTitlePaddingTop] = useState<number>(5);
    const [localStandoutTitlePaddingBottom, setLocalStandoutTitlePaddingBottom] = useState<number>(5);
    const [localStandoutContentPaddingLeft, setLocalStandoutContentPaddingLeft] = useState<number>(10);
    const [localStandoutContentPaddingTop, setLocalStandoutContentPaddingTop] = useState<number>(8);
    const [localStandoutContentPaddingRight, setLocalStandoutContentPaddingRight] = useState<number>(12);
    const [localStandoutContentPaddingBottom, setLocalStandoutContentPaddingBottom] = useState<number>(12);
    const [localStandoutBorderColor, setLocalStandoutBorderColor] = useState<string>('#ffffff');
    const [localStandoutDividerColor, setLocalStandoutDividerColor] = useState<string>('#ffffff');
    const [localStandoutBorderWidth, setLocalStandoutBorderWidth] = useState<number>(1);
    const [localStandoutDividerWidth, setLocalStandoutDividerWidth] = useState<number>(1);
    const [localStandoutTitleFontSizeBase, setLocalStandoutTitleFontSizeBase] = useState<number>(24);
    const [localStandoutTitleFontSizeStep, setLocalStandoutTitleFontSizeStep] = useState<number>(2);
    const [localStandoutTitleFontSizeMin, setLocalStandoutTitleFontSizeMin] = useState<number>(18);
    const [localStandoutBgLightenStep, setLocalStandoutBgLightenStep] = useState<number>(2);
    const [localStandoutBgOpacityClosed, setLocalStandoutBgOpacityClosed] = useState<number>(30);
    const [localStandoutBgOpacityClosedHover, setLocalStandoutBgOpacityClosedHover] = useState<number>(40);
    const [localStandoutBgOpacityOpen, setLocalStandoutBgOpacityOpen] = useState<number>(80);
    const [localStandoutBgOpacityOpenHover, setLocalStandoutBgOpacityOpenHover] = useState<number>(90);
    const [localMathBlockPaddingY, setLocalMathBlockPaddingY] = useState<number>(4);
    const [validationErrors, setValidationErrors] = useState<string[]>([]);
    const [localMathColors, setLocalMathColors] = useState<Record<string, string>>({
        command: "#61afef",
        brace: "#e5c07b",
        script: "#c678dd",
        comment: "#8b949e",
        delimiter: "#98c379",
        align: "#e06c75",
        escaped: "#56b6c2"
    });

    useEffect(() => {
        if (isOpen) {
            setValidationErrors([]);
            setLocalMacros(Object.entries(settings.macros || {}).map(([key, value]) => ({ key, value })));
            setLocalCommands([...(settings.customCommands || [])]);
            setLocalTextCommands([...(settings.textCommands || [])]);
            setLocalSearchShortcut(settings.searchShortcut || 'meta+k');
            setLocalEditMetadataShortcut(settings.editMetadataShortcut || 'f2');
            setLocalGoToParentShortcut(settings.goToParentShortcut || 'mod+shift+arrowup');
            setLocalCloseTabShortcut(settings.closeTabShortcut || 'mod+w');
            setLocalReopenTabShortcut(settings.reopenClosedTabShortcut || 'mod+shift+t');
            setLocalNextTabShortcut(settings.nextTabShortcut || 'ctrl+tab');
            setLocalPreviousTabShortcut(settings.previousTabShortcut || 'ctrl+shift+tab');
            if (window.mathNotesDesktop) {
                void window.mathNotesDesktop.getWorkspacePath().then(setWorkspacePath).catch(() => setWorkspacePath(null));
            } else {
                setWorkspacePath(null);
            }
            setLocalInlineBlockColorFilled(settings.inlineBlockTitleColorWithContent || '#a8b5c2');
            setLocalInlineBlockColorEmpty(settings.inlineBlockTitleColorEmpty || '#FF997D');
            setLocalInlineBlockTitleUnderlineOpacity(settings.inlineBlockTitleUnderlineOpacity ?? 100);
            setLocalInlineBlockIndentWidth(settings.inlineBlockIndentWidth ?? 16);
            setLocalStandoutBlockColorFilled(settings.standoutBlockTitleColorWithContent || '#a8b5c2');
            setLocalStandoutBlockColorEmpty(settings.standoutBlockTitleColorEmpty || '#FF997D');
            setLocalStandoutBlockIndentWidth(settings.standoutBlockIndentWidth ?? 0);
            setLocalStandoutTitlePaddingLeft(settings.standoutBlockTitlePaddingLeft ?? 10);
            setLocalStandoutTitlePaddingRight(settings.standoutBlockTitlePaddingRight ?? 6);
            setLocalStandoutTitlePaddingTop(settings.standoutBlockTitlePaddingTop ?? 5);
            setLocalStandoutTitlePaddingBottom(settings.standoutBlockTitlePaddingBottom ?? 5);
            setLocalStandoutContentPaddingLeft(settings.standoutBlockContentPaddingLeft ?? 10);
            setLocalStandoutContentPaddingTop(settings.standoutBlockContentPaddingTop ?? 8);
            setLocalStandoutContentPaddingRight(settings.standoutBlockContentPaddingRight ?? 12);
            setLocalStandoutContentPaddingBottom(settings.standoutBlockContentPaddingBottom ?? 12);
            setLocalStandoutBorderColor(settings.standoutBlockBorderColor || '#ffffff');
            setLocalStandoutDividerColor(settings.standoutBlockDividerColor || '#ffffff');
            setLocalStandoutBorderWidth(settings.standoutBlockBorderWidth ?? 1);
            setLocalStandoutDividerWidth(settings.standoutBlockDividerWidth ?? 1);
            setLocalStandoutTitleFontSizeBase(settings.standoutBlockTitleFontSizeBase ?? 24);
            setLocalStandoutTitleFontSizeStep(settings.standoutBlockTitleFontSizeStep ?? 2);
            setLocalStandoutTitleFontSizeMin(settings.standoutBlockTitleFontSizeMin ?? 18);
            setLocalStandoutBgLightenStep(settings.standoutBlockBgLightenStep ?? 2);
            setLocalStandoutBgOpacityClosed(settings.standoutBlockBgOpacityClosed ?? 30);
            setLocalStandoutBgOpacityClosedHover(settings.standoutBlockBgOpacityClosedHover ?? 40);
            setLocalStandoutBgOpacityOpen(settings.standoutBlockBgOpacityOpen ?? 80);
            setLocalStandoutBgOpacityOpenHover(settings.standoutBlockBgOpacityOpenHover ?? 90);
            setLocalMathBlockPaddingY(settings.mathBlockPaddingY ?? 4);
            setLocalMathHighlightColor(settings.mathHighlightColor || '#d19a66');
            if (settings.mathColors) {
                setLocalMathColors({ ...settings.mathColors });
            }
        }
    }, [isOpen, settings]);

    useEffect(() => {
        if (!isOpen) return;
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeButtonRef.current?.focus();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;

            const focusable = Array.from(dialogRef.current.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )) as HTMLElement[];
            const visibleFocusable = focusable.filter(element => element.offsetParent !== null);
            if (visibleFocusable.length === 0) return;
            const first = visibleFocusable[0];
            const last = visibleFocusable[visibleFocusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            previouslyFocused?.focus();
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const importSettings = async (file: File) => {
        try {
            const parsed: unknown = JSON.parse(await file.text());
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
                !['macros', 'customCommands', 'textCommands'].some(key => key in parsed)) {
                throw new Error('Choose a Math Note Editor settings.json file.');
            }
            const preferences = { ...(parsed as Record<string, unknown>) };
            delete preferences.workspaceSession;
            await saveSettings({ ...settings, ...preferences });
            const error = useStore.getState().persistenceError;
            setImportMessage(error || 'Settings imported into this Google Drive folder. Open tabs were kept separate.');
        } catch (error) {
            setImportMessage(error instanceof Error ? error.message : String(error));
        }
    };

    const handleSave = () => {
        const errors: string[] = [];
        const newMacros: Record<string, string> = {};
        for (const m of localMacros) {
            if (m.key.trim()) {
                const key = normalizeMathCommand(m.key);
                if (!/^\\[A-Za-z]+$/.test(key)) errors.push(`Macro name "${m.key.trim()}" must be a backslash followed by letters.`);
                if (!m.value.trim()) errors.push(`Macro "${key}" needs a replacement value.`);
                if (Object.prototype.hasOwnProperty.call(newMacros, key)) errors.push(`Macro "${key}" is duplicated.`);
                newMacros[key] = m.value.trim();
            }
        }
        
        const newCommands = localCommands
            .map(c => c.trim())
            .filter(c => c.length > 0)
            .map(normalizeMathCommand);

        const newTextCommands = localTextCommands
            .map(c => c.trim())
            .filter(c => c.length > 0);

        for (const command of newCommands) {
            if (!MATH_COMMAND.test(command)) errors.push(`Autocomplete command "${command}" is not valid.`);
        }
        if (new Set(newCommands).size !== newCommands.length) errors.push('Autocomplete commands must be unique.');
        if (newTextCommands.some(command => command.includes('\n'))) errors.push('Text autocomplete entries must use one line.');
        if (new Set(newTextCommands).size !== newTextCommands.length) errors.push('Text autocomplete entries must be unique.');

        const normalizedShortcuts = {
            search: localSearchShortcut.trim().toLowerCase(),
            editMetadata: localEditMetadataShortcut.trim().toLowerCase(),
            goToParent: localGoToParentShortcut.trim().toLowerCase(),
            closeTab: localCloseTabShortcut.trim().toLowerCase(),
            reopenTab: localReopenTabShortcut.trim().toLowerCase(),
            nextTab: localNextTabShortcut.trim().toLowerCase(),
            previousTab: localPreviousTabShortcut.trim().toLowerCase()
        };
        for (const [name, shortcut] of Object.entries(normalizedShortcuts)) {
            if (!isValidShortcut(shortcut)) errors.push(`${({ search: 'Search', editMetadata: 'Edit block metadata', goToParent: 'Go to parent', closeTab: 'Close tab', reopenTab: 'Reopen tab', nextTab: 'Next tab', previousTab: 'Previous tab' } as Record<string, string>)[name]} shortcut must be F1–F12 or contain Ctrl, Meta, Cmd, or Mod plus one supported key.`);
        }
        const shortcutValues = Object.values(normalizedShortcuts);
        if (new Set(shortcutValues).size !== shortcutValues.length) {
            errors.push('Keyboard shortcuts must be unique.');
        }

        const colorValues = [
            ['Inline title color', localInlineBlockColorFilled],
            ['Empty inline title color', localInlineBlockColorEmpty],
            ['Standout title color', localStandoutBlockColorFilled],
            ['Empty standout title color', localStandoutBlockColorEmpty],
            ['Standout border color', localStandoutBorderColor],
            ['Standout divider color', localStandoutDividerColor],
            ['Math text color', localMathHighlightColor],
            ...Object.entries(localMathColors).map(([name, value]) => [`Math ${name} color`, value])
        ];
        for (const [label, value] of colorValues) {
            if (!HEX_COLOR.test(value.trim())) errors.push(`${label} must be a six-digit hex color such as #61afef.`);
        }

        const numericValues: Array<[string, number, number, number]> = [
            ['Inline block indent', localInlineBlockIndentWidth, 0, 200],
            ['Inline title underline opacity', localInlineBlockTitleUnderlineOpacity, 0, 100],
            ['Standout block indent', localStandoutBlockIndentWidth, 0, 200],
            ['Standout title left padding', localStandoutTitlePaddingLeft, 0, 200],
            ['Standout title right padding', localStandoutTitlePaddingRight, 0, 200],
            ['Standout title top padding', localStandoutTitlePaddingTop, 0, 200],
            ['Standout title bottom padding', localStandoutTitlePaddingBottom, 0, 200],
            ['Standout content left padding', localStandoutContentPaddingLeft, 0, 200],
            ['Standout content right padding', localStandoutContentPaddingRight, 0, 200],
            ['Standout content top padding', localStandoutContentPaddingTop, 0, 200],
            ['Standout content bottom padding', localStandoutContentPaddingBottom, 0, 200],
            ['Standout border width', localStandoutBorderWidth, 0, 20],
            ['Standout divider width', localStandoutDividerWidth, 0, 20],
            ['Standout base title size', localStandoutTitleFontSizeBase, 8, 96],
            ['Standout title size step', localStandoutTitleFontSizeStep, 0, 24],
            ['Standout minimum title size', localStandoutTitleFontSizeMin, 8, 96],
            ['Standout background lighten step', localStandoutBgLightenStep, 0, 100],
            ['Closed background opacity', localStandoutBgOpacityClosed, 0, 100],
            ['Closed hover background opacity', localStandoutBgOpacityClosedHover, 0, 100],
            ['Open background opacity', localStandoutBgOpacityOpen, 0, 100],
            ['Open hover background opacity', localStandoutBgOpacityOpenHover, 0, 100],
            ['Math block vertical padding', localMathBlockPaddingY, 0, 100]
        ];
        for (const [label, value, min, max] of numericValues) {
            if (!Number.isFinite(value) || value < min || value > max) errors.push(`${label} must be between ${min} and ${max}.`);
        }

        if (errors.length > 0) {
            setValidationErrors(errors);
            return;
        }

        setValidationErrors([]);
            
        saveSettings({
            ...settings,
            macros: newMacros,
            customCommands: newCommands,
            textCommands: newTextCommands,
            searchShortcut: normalizedShortcuts.search,
            editMetadataShortcut: normalizedShortcuts.editMetadata,
            goToParentShortcut: normalizedShortcuts.goToParent,
            closeTabShortcut: normalizedShortcuts.closeTab,
            reopenClosedTabShortcut: normalizedShortcuts.reopenTab,
            nextTabShortcut: normalizedShortcuts.nextTab,
            previousTabShortcut: normalizedShortcuts.previousTab,
            inlineBlockTitleColorWithContent: localInlineBlockColorFilled.trim(),
            inlineBlockTitleColorEmpty: localInlineBlockColorEmpty.trim(),
            inlineBlockTitleUnderlineOpacity: localInlineBlockTitleUnderlineOpacity,
            inlineBlockIndentWidth: localInlineBlockIndentWidth,
            standoutBlockTitleColorWithContent: localStandoutBlockColorFilled.trim(),
            standoutBlockTitleColorEmpty: localStandoutBlockColorEmpty.trim(),
            standoutBlockIndentWidth: localStandoutBlockIndentWidth,
            standoutBlockTitlePaddingLeft: localStandoutTitlePaddingLeft,
            standoutBlockTitlePaddingRight: localStandoutTitlePaddingRight,
            standoutBlockTitlePaddingTop: localStandoutTitlePaddingTop,
            standoutBlockTitlePaddingBottom: localStandoutTitlePaddingBottom,
            standoutBlockContentPaddingLeft: localStandoutContentPaddingLeft,
            standoutBlockContentPaddingTop: localStandoutContentPaddingTop,
            standoutBlockContentPaddingRight: localStandoutContentPaddingRight,
            standoutBlockContentPaddingBottom: localStandoutContentPaddingBottom,
            standoutBlockBorderColor: localStandoutBorderColor.trim(),
            standoutBlockDividerColor: localStandoutDividerColor.trim(),
            standoutBlockBorderWidth: localStandoutBorderWidth,
            standoutBlockDividerWidth: localStandoutDividerWidth,
            standoutBlockTitleFontSizeBase: localStandoutTitleFontSizeBase,
            standoutBlockTitleFontSizeStep: localStandoutTitleFontSizeStep,
            standoutBlockTitleFontSizeMin: localStandoutTitleFontSizeMin,
            standoutBlockBgLightenStep: localStandoutBgLightenStep,
            standoutBlockBgOpacityClosed: localStandoutBgOpacityClosed,
            standoutBlockBgOpacityClosedHover: localStandoutBgOpacityClosedHover,
            standoutBlockBgOpacityOpen: localStandoutBgOpacityOpen,
            standoutBlockBgOpacityOpenHover: localStandoutBgOpacityOpenHover,
            mathBlockPaddingY: localMathBlockPaddingY,
            mathHighlightColor: localMathHighlightColor.trim(),
            mathColors: { ...localMathColors } as any
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
    const moveMacro = (index: number, dir: -1 | 1) => {
        if (index + dir < 0 || index + dir >= localMacros.length) return;
        const newMacros = [...localMacros];
        const temp = newMacros[index];
        newMacros[index] = newMacros[index + dir];
        newMacros[index + dir] = temp;
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

    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const focusedTabId = event.target instanceof HTMLElement
            ? event.target.id.replace('settings-tab-', '')
            : activeTab;
        const focusedIndex = settingsTabs.findIndex(tab => tab.id === focusedTabId);
        const currentIndex = focusedIndex >= 0 ? focusedIndex : settingsTabs.findIndex(tab => tab.id === activeTab);
        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? settingsTabs.length - 1
                : (currentIndex + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + settingsTabs.length) % settingsTabs.length;
        const nextTab = settingsTabs[nextIndex];
        setActiveTab(nextTab.id);
        dialogRef.current?.querySelector<HTMLElement>(`#settings-tab-${nextTab.id}`)?.focus();
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="editor-settings-title"
                aria-describedby={validationErrors.length > 0 ? "settings-validation-errors" : undefined}
                className="bg-surface rounded-xl shadow-xl w-full max-w-4xl h-[75vh] flex flex-col border border-outline overflow-hidden"
            >
                <div className="flex justify-between items-center p-4 border-b border-outline">
                    <h2 id="editor-settings-title" className="text-lg font-bold text-primary">Editor Settings</h2>
                    <button ref={closeButtonRef} onClick={onClose} aria-label="Close settings" className="p-1 text-secondary hover:text-primary transition-colors">
                        <X size={20} aria-hidden="true" />
                    </button>
                </div>

                {validationErrors.length > 0 && (
                    <div id="settings-validation-errors" role="alert" className="mx-4 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                        <p className="font-semibold">Please correct these settings:</p>
                        <ul className="mt-1 list-disc pl-5">
                            {validationErrors.map(error => <li key={error}>{error}</li>)}
                        </ul>
                    </div>
                )}
                
                <div className="flex flex-1 overflow-hidden">
                    {/* Left Sidebar */}
                    <div role="tablist" aria-label="Settings sections" onKeyDown={handleTabKeyDown} className="w-48 md:w-64 border-r border-outline flex flex-col p-3 space-y-1 bg-base/30">
                        {settingsTabs.map(tab => (
                            <button
                                key={tab.id}
                                id={`settings-tab-${tab.id}`}
                                role="tab"
                                tabIndex={activeTab === tab.id ? 0 : -1}
                                aria-selected={activeTab === tab.id}
                                aria-controls="settings-active-panel"
                                className={`px-3 py-2.5 text-sm font-medium rounded-lg text-left transition-colors ${activeTab === tab.id ? 'bg-accent/10 text-accent' : 'text-secondary hover:bg-outline/50 hover:text-primary'}`}
                                onClick={() => setActiveTab(tab.id)}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {/* Right Content */}
                    <div id="settings-active-panel" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`} className="flex-1 overflow-y-auto p-6 space-y-6">
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
                                                    aria-label={`Macro ${i + 1} name`}
                                                    placeholder="\macro"
                                                    value={macro.key}
                                                    onChange={(e) => updateMacro(i, 'key', e.target.value)}
                                                    className="w-1/3 bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent min-w-0"
                                                />
                                                <span className="text-secondary">=</span>
                                                <input
                                                    type="text"
                                                    aria-label={`Macro ${i + 1} replacement`}
                                                    placeholder="\mathbb{R}"
                                                    value={macro.value}
                                                    onChange={(e) => updateMacro(i, 'value', e.target.value)}
                                                    className="flex-1 bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent min-w-0"
                                                />
                                                <div className="flex items-center">
                                                    <button
                                                        aria-label={`Move macro ${i + 1} up`}
                                                        onClick={() => moveMacro(i, -1)}
                                                        disabled={i === 0}
                                                        className="p-2 flex-shrink-0 text-secondary hover:text-accent disabled:opacity-30 rounded transition-colors"
                                                    >
                                                        <ArrowUp size={18} aria-hidden="true" />
                                                    </button>
                                                    <button
                                                        aria-label={`Move macro ${i + 1} down`}
                                                        onClick={() => moveMacro(i, 1)}
                                                        disabled={i === localMacros.length - 1}
                                                        className="p-2 flex-shrink-0 text-secondary hover:text-accent disabled:opacity-30 rounded transition-colors"
                                                    >
                                                        <ArrowDown size={18} aria-hidden="true" />
                                                    </button>
                                                    <button
                                                        aria-label={`Remove macro ${i + 1}`}
                                                        onClick={() => removeMacro(i)}
                                                        className="p-2 flex-shrink-0 text-secondary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors ml-1"
                                                    >
                                                        <Trash2 size={18} aria-hidden="true" />
                                                    </button>
                                                </div>
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
                                                        aria-label={`Autocomplete command ${i + 1}`}
                                                        placeholder="\mycommand"
                                                        value={cmd}
                                                        onChange={(e) => updateCommand(i, e.target.value)}
                                                        className="w-full bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    />
                                                </div>
                                                <button
                                                    aria-label={`Move autocomplete command ${i + 1} up`}
                                                    onClick={() => moveCommand(i, -1)}
                                                    disabled={i === 0}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowUp size={16} aria-hidden="true" />
                                                </button>
                                                <button
                                                    aria-label={`Move autocomplete command ${i + 1} down`}
                                                    onClick={() => moveCommand(i, 1)}
                                                    disabled={i === localCommands.length - 1}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowDown size={16} aria-hidden="true" />
                                                </button>
                                                <button
                                                    aria-label={`Remove autocomplete command ${i + 1}`}
                                                    onClick={() => removeCommand(i)}
                                                    className="p-1.5 text-secondary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                                >
                                                    <Trash2 size={16} aria-hidden="true" />
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
                                                        aria-label={`Text autocomplete entry ${i + 1}`}
                                                        placeholder="command"
                                                        value={cmd}
                                                        onChange={(e) => updateTextCommand(i, e.target.value)}
                                                        className="w-full bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    />
                                                </div>
                                                <button
                                                    aria-label={`Move text autocomplete entry ${i + 1} up`}
                                                    onClick={() => moveTextCommand(i, -1)}
                                                    disabled={i === 0}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowUp size={16} aria-hidden="true" />
                                                </button>
                                                <button
                                                    aria-label={`Move text autocomplete entry ${i + 1} down`}
                                                    onClick={() => moveTextCommand(i, 1)}
                                                    disabled={i === localTextCommands.length - 1}
                                                    className="p-1.5 text-secondary hover:text-primary hover:bg-outline/50 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-secondary"
                                                >
                                                    <ArrowDown size={16} aria-hidden="true" />
                                                </button>
                                                <button
                                                    aria-label={`Remove text autocomplete entry ${i + 1}`}
                                                    onClick={() => removeTextCommand(i)}
                                                    className="p-1.5 text-secondary hover:text-red-500 hover:bg-red-500/10 rounded transition-colors"
                                                >
                                                    <Trash2 size={16} aria-hidden="true" />
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

                        {activeTab === 'general' && (
                            <div className="max-w-2xl">
                                <h3 className="text-base font-semibold text-primary mb-1">General Setting</h3>
                                <p className="text-sm text-secondary mb-6">Manage the current workspace and its settings.</p>
                                <div className="rounded-lg border border-outline bg-base/40 p-4">
                                    <h4 className="text-sm font-semibold text-primary">Workspace Folder</h4>
                                    <p className="mt-1 text-xs text-secondary">Your notes and workspace settings belong to the selected folder.</p>
                                    {window.mathNotesDesktop ? (
                                        <>
                                            <div className="mt-4 rounded-md border border-outline bg-surface px-3 py-2">
                                                <p className="text-[11px] font-medium uppercase tracking-wide text-secondary">Current path</p>
                                                <p className="mt-1 break-all font-mono text-xs text-primary" aria-label="Current workspace path">
                                                    {workspacePath || 'Loading…'}
                                                </p>
                                            </div>
                                            <div className="mt-4 flex flex-wrap gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => { void window.mathNotesDesktop?.chooseWorkspace(); }}
                                                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
                                                >
                                                    Change Workspace Folder…
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { void window.mathNotesDesktop?.showWorkspaceInFolder(); }}
                                                    disabled={!workspacePath}
                                                    className="rounded-lg border border-outline bg-surface px-4 py-2 text-sm font-medium text-primary hover:bg-outline/40 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    Show in Finder
                                                </button>
                                            </div>
                                        </>
                                    ) : <>
                                        <div className="mt-4 rounded-md border border-outline bg-surface px-3 py-2">
                                            <p className="text-[11px] font-medium uppercase tracking-wide text-secondary">Current workspace</p>
                                            <p className="mt-1 break-all text-sm text-primary" aria-label="Current workspace">
                                                {backendMode === 'google' ? `Google Drive · ${workspaceName || 'Selected folder'}` :
                                                    backendMode === 'server' ? `Local server · ${workspaceName || 'Workspace'}` :
                                                    backendMode === 'local' ? `Local folder · ${workspaceName || 'Selected folder'}` :
                                                    backendMode === 'viewer' ? `Read-only folder · ${workspaceName || 'Selected folder'}` : 'None connected'}
                                            </p>
                                        </div>
                                        <div className="mt-4 flex flex-wrap gap-2">
                                            {backendMode === 'google' ? <>
                                                <button type="button" onClick={() => void connectGoogleDrive()} disabled={isLoadingFiles} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50">Change Drive folder…</button>
                                                <button type="button" onClick={() => void disconnectGoogleDrive()} disabled={isLoadingFiles} className="rounded-lg border border-outline px-4 py-2 text-sm text-primary hover:bg-outline/40 disabled:opacity-50">Disconnect Drive</button>
                                            </> : backendMode !== 'viewer' ? <button type="button" onClick={() => void connectLocalFS()} disabled={isLoadingFiles} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50">{backendMode === 'none' ? 'Open local folder…' : 'Change local folder…'}</button> : null}
                                            <input ref={viewerFolderRef} type="file" className="hidden" webkitdirectory="" onChange={event => { if (event.target.files?.length) void loadViewerFiles(event.target.files); event.target.value = ''; }} />
                                            <button type="button" onClick={() => viewerFolderRef.current?.click()} disabled={isLoadingFiles} className="rounded-lg border border-outline px-4 py-2 text-sm text-primary hover:bg-outline/40 disabled:opacity-50">{backendMode === 'viewer' ? 'Change read-only folder…' : 'View folder read-only…'}</button>
                                        </div>
                                        {backendMode === 'google' && <div className="mt-4 border-t border-outline pt-4">
                                            <p className="text-xs text-secondary">Settings from this folder's setting/settings.json load automatically. To copy preferences from a different local workspace, choose its settings file. This replaces Drive preferences, not its open tabs.</p>
                                            <input ref={settingsFileRef} type="file" accept=".json,application/json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void importSettings(file); event.target.value = ''; }} />
                                            <button type="button" onClick={() => settingsFileRef.current?.click()} className="mt-3 rounded-lg border border-outline px-4 py-2 text-sm text-primary hover:bg-outline/40">Import local settings…</button>
                                            {importMessage && <p className="mt-2 text-xs text-secondary" role="status">{importMessage}</p>}
                                        </div>}
                                        {persistenceError && <p className="mt-3 text-xs text-red-500" role="alert">{persistenceError}</p>}
                                    </>}
                                </div>
                                <BackupRecovery />
                            </div>
                        )}

                        {activeTab === 'keyboard' && (
                            <div className="max-w-2xl">
                                <h3 className="text-base font-semibold text-primary mb-1">Keyboard Shortcuts</h3>
                                <p className="text-sm text-secondary mb-6">
                                    Configure application and navigation shortcuts for the web and desktop applications.
                                </p>
                                
                                <div className="space-y-4">
                                    <div>
                                        <h4 className="text-sm font-semibold text-primary mb-3">Application shortcuts</h4>
                                        <div className="space-y-3">
                                        <div className="grid grid-cols-[minmax(180px,auto)_1fr] gap-3 rounded-lg border border-outline bg-base/40 px-3 py-3">
                                            <input
                                                id="settings-search-shortcut"
                                                aria-label="Global search shortcut"
                                                type="text"
                                                value={localSearchShortcut}
                                                onChange={(e) => setLocalSearchShortcut(e.target.value)}
                                                placeholder="e.g. mod+k"
                                                className="w-full rounded border border-outline bg-surface px-3 py-2 text-xs font-mono text-primary focus:border-accent focus:outline-none"
                                            />
                                            <div>
                                                <label htmlFor="settings-search-shortcut" className="text-sm font-medium text-primary">Global search</label>
                                                <p className="text-xs text-secondary">Opens note search from anywhere in the application.</p>
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-[minmax(180px,auto)_1fr] gap-3 rounded-lg border border-outline bg-base/40 px-3 py-3">
                                            <input
                                                id="settings-edit-metadata-shortcut"
                                                aria-label="Edit active block metadata shortcut"
                                                type="text"
                                                value={localEditMetadataShortcut}
                                                onChange={(e) => setLocalEditMetadataShortcut(e.target.value)}
                                                placeholder="e.g. f2"
                                                className="w-full rounded border border-outline bg-surface px-3 py-2 text-xs font-mono text-primary focus:border-accent focus:outline-none"
                                            />
                                            <div>
                                                <label htmlFor="settings-edit-metadata-shortcut" className="text-sm font-medium text-primary">Edit active block title and label</label>
                                                <p className="text-xs text-secondary">Opens the same metadata editor as double-clicking the note header. On some Macs, press Fn+F2.</p>
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-[minmax(180px,auto)_1fr] gap-3 rounded-lg border border-outline bg-base/40 px-3 py-3">
                                            <input
                                                id="settings-go-to-parent-shortcut"
                                                aria-label="Go to nearest parent block shortcut"
                                                type="text"
                                                value={localGoToParentShortcut}
                                                onChange={(e) => setLocalGoToParentShortcut(e.target.value)}
                                                placeholder="e.g. mod+shift+arrowup"
                                                className="w-full rounded border border-outline bg-surface px-3 py-2 text-xs font-mono text-primary focus:border-accent focus:outline-none"
                                            />
                                            <div>
                                                <label htmlFor="settings-go-to-parent-shortcut" className="text-sm font-medium text-primary">Go to nearest parent block</label>
                                                <p className="text-xs text-secondary">Opens the closest existing ancestor of the current root note in a tab beside it.</p>
                                            </div>
                                        </div>
                                        </div>
                                    </div>

                                    <div className="border-t border-outline pt-4">
                                        <h4 className="text-sm font-semibold text-primary mb-1">Note tab shortcuts</h4>
                                        <p className="text-xs text-secondary mb-3"><code>mod</code> means Cmd on macOS and Ctrl on Windows/Linux. Desktop applies these shortcuts globally; a web browser may keep reserved combinations such as Ctrl+Tab.</p>
                                        <div className="space-y-3">
                                            {[
                                                { id: 'settings-close-tab-shortcut', value: localCloseTabShortcut, setter: setLocalCloseTabShortcut, action: 'Close current note tab', detail: 'Closes the tab without deleting its note.' },
                                                { id: 'settings-reopen-tab-shortcut', value: localReopenTabShortcut, setter: setLocalReopenTabShortcut, action: 'Reopen closed note tab', detail: 'Restores the most recently closed tab, including its former position and editor focus.' },
                                                { id: 'settings-next-tab-shortcut', value: localNextTabShortcut, setter: setLocalNextTabShortcut, action: 'Next note tab', detail: 'Moves to the next open note and wraps after the last tab.' },
                                                { id: 'settings-previous-tab-shortcut', value: localPreviousTabShortcut, setter: setLocalPreviousTabShortcut, action: 'Previous note tab', detail: 'Moves to the previous open note and wraps before the first tab.' }
                                            ].map(shortcut => (
                                                <div key={shortcut.id} className="grid grid-cols-[minmax(180px,auto)_1fr] gap-3 rounded-lg border border-outline bg-base/40 px-3 py-3">
                                                    <input
                                                        id={shortcut.id}
                                                        aria-label={`${shortcut.action} shortcut`}
                                                        type="text"
                                                        value={shortcut.value}
                                                        onChange={event => shortcut.setter(event.target.value)}
                                                        className="w-full rounded border border-outline bg-surface px-3 py-2 text-xs font-mono text-primary focus:border-accent focus:outline-none"
                                                    />
                                                    <div>
                                                        <label htmlFor={shortcut.id} className="text-sm font-medium text-primary">{shortcut.action}</label>
                                                        <p className="text-xs text-secondary">{shortcut.detail}</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="border-t border-outline pt-4">
                                        <h4 className="text-sm font-semibold text-primary mb-1">Focused tab-strip controls</h4>
                                        <p className="text-xs text-secondary mb-3">Focus a tab with the Tab key, then use these controls in either version.</p>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                                            <p><kbd className="font-mono text-primary">← / →</kbd><span className="text-secondary"> — focus the previous or next tab</span></p>
                                            <p><kbd className="font-mono text-primary">Home / End</kbd><span className="text-secondary"> — focus the first or last tab</span></p>
                                            <p><kbd className="font-mono text-primary">Enter / Space</kbd><span className="text-secondary"> — activate the focused tab</span></p>
                                            <p><kbd className="font-mono text-primary">Delete / Backspace</kbd><span className="text-secondary"> — close the focused tab</span></p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeTab === 'embedded' && (
                            <div className="max-w-2xl">
                                <h3 className="text-base font-semibold text-primary mb-1">Inline Embedded Block Settings</h3>
                                <p className="text-sm text-secondary mb-6">Configure how inline embedded blocks appear.</p>
                                
                                <div className="space-y-4">
                                    <div className="flex flex-col gap-2">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {[
                                                { key: 'filledColor', label: 'Color (with content)', value: localInlineBlockColorFilled, setter: setLocalInlineBlockColorFilled },
                                                { key: 'emptyColor', label: 'Color (empty)', value: localInlineBlockColorEmpty, setter: setLocalInlineBlockColorEmpty }
                                            ].map(item => (
                                                <div key={item.key} className="flex gap-2 items-center">
                                                    <div className="w-6 h-6 rounded border border-outline shrink-0 flex items-center justify-center overflow-hidden relative" style={{ backgroundColor: item.value }}>
                                                        <input
                                                            type="color"
                                                            aria-label={`${item.label} color picker`}
                                                            value={item.value?.startsWith('#') ? item.value.slice(0, 7) : '#000000'}
                                                            onChange={(e) => item.setter(e.target.value)}
                                                            className="opacity-0 cursor-pointer w-10 h-10 absolute"
                                                        />
                                                    </div>
                                                    <input
                                                        type="text"
                                                        aria-label={`${item.label} hex color`}
                                                        value={item.value || ''}
                                                        onChange={(e) => item.setter(e.target.value)}
                                                        className="w-24 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    />
                                                    <span className="text-xs text-secondary ml-1">{item.label}</span>
                                                </div>
                                            ))}
                                            <div className="flex gap-2 items-center">
                                                <span className="w-6 h-6 shrink-0 flex items-center justify-center text-secondary">
                                                    px
                                                </span>
                                                <input
                                                    type="number"
                                                    aria-label="Inline block left padding"
                                                    value={isNaN(localInlineBlockIndentWidth) ? '' : localInlineBlockIndentWidth}
                                                    onChange={(e) => setLocalInlineBlockIndentWidth(parseInt(e.target.value))}
                                                    min="0"
                                                    max="200"
                                                    className="w-24 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                />
                                                <span className="text-xs text-secondary ml-1">Left Padding/Indent</span>
                                            </div>
                                            <div className="flex gap-2 items-center">
                                                <span className="w-6 h-6 shrink-0 flex items-center justify-center text-secondary">
                                                    %
                                                </span>
                                                <input
                                                    type="number"
                                                    aria-label="Inline title underline opacity"
                                                    value={isNaN(localInlineBlockTitleUnderlineOpacity) ? '' : localInlineBlockTitleUnderlineOpacity}
                                                    onChange={(e) => setLocalInlineBlockTitleUnderlineOpacity(parseInt(e.target.value))}
                                                    className="w-24 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    min="0"
                                                    max="100"
                                                />
                                                <span className="text-xs text-secondary ml-1">Title Underline Opacity</span>
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div className="flex flex-col gap-2 mt-8">
                                        <h3 className="text-base font-semibold text-primary mb-1">Standout Embedded Block Settings</h3>
                                        <p className="text-sm text-secondary mb-4">Configure how standout embedded blocks appear.</p>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {[
                                                { key: 'standoutFilledColor', label: 'Color (with content)', value: localStandoutBlockColorFilled, setter: setLocalStandoutBlockColorFilled },
                                                { key: 'standoutEmptyColor', label: 'Color (empty)', value: localStandoutBlockColorEmpty, setter: setLocalStandoutBlockColorEmpty }
                                            ].map(item => (
                                                <div key={item.key} className="flex gap-2 items-center">
                                                    <div className="w-6 h-6 rounded border border-outline shrink-0 flex items-center justify-center overflow-hidden relative" style={{ backgroundColor: item.value }}>
                                                        <input
                                                            type="color"
                                                            aria-label={`Standout ${item.label.toLowerCase()} color picker`}
                                                            value={item.value?.startsWith('#') ? item.value.slice(0, 7) : '#000000'}
                                                            onChange={(e) => item.setter(e.target.value)}
                                                            className="opacity-0 cursor-pointer w-10 h-10 absolute"
                                                        />
                                                    </div>
                                                    <input
                                                        type="text"
                                                        aria-label={`Standout ${item.label.toLowerCase()} hex color`}
                                                        value={item.value || ''}
                                                        onChange={(e) => item.setter(e.target.value)}
                                                        className="w-24 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    />
                                                    <span className="text-xs text-secondary ml-1">{item.label}</span>
                                                </div>
                                            ))}
                                            <div className="flex gap-2 items-center">
                                                <span className="w-6 h-6 shrink-0 flex items-center justify-center text-secondary">
                                                    px
                                                </span>
                                                <input
                                                    type="number"
                                                    aria-label="Standout block left padding"
                                                    value={isNaN(localStandoutBlockIndentWidth) ? '' : localStandoutBlockIndentWidth}
                                                    onChange={(e) => setLocalStandoutBlockIndentWidth(parseInt(e.target.value))}
                                                    min="0"
                                                    max="200"
                                                    className="w-24 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                />
                                                <span className="text-xs text-secondary ml-1">Left Padding/Indent</span>
                                            </div>
                                            
                                            <div className="col-span-1 md:col-span-2 border-t border-outline pt-4 mt-2">
                                                <p className="text-sm font-semibold text-primary mb-2">Title Padding</p>
                                                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                                    {[
                                                        { key: 't-pl', label: 'Left', value: localStandoutTitlePaddingLeft, setter: setLocalStandoutTitlePaddingLeft },
                                                        { key: 't-pr', label: 'Right', value: localStandoutTitlePaddingRight, setter: setLocalStandoutTitlePaddingRight },
                                                        { key: 't-pt', label: 'Top', value: localStandoutTitlePaddingTop, setter: setLocalStandoutTitlePaddingTop },
                                                        { key: 't-pb', label: 'Bottom', value: localStandoutTitlePaddingBottom, setter: setLocalStandoutTitlePaddingBottom },
                                                    ].map(item => (
                                                        <div key={item.key} className="flex gap-2 items-center">
                                                            <input
                                                                type="number"
                                                                aria-label={`Standout title ${item.label.toLowerCase()} padding`}
                                                                value={isNaN(item.value) ? '' : item.value}
                                                                onChange={(e) => item.setter(parseInt(e.target.value))}
                                                                min="0"
                                                                max="200"
                                                                className="w-16 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                            />
                                                            <span className="text-xs text-secondary">{item.label} (px)</span>
                                                        </div>
                                                    ))}
                                                </div>
                                                <p className="text-sm font-semibold text-primary mt-4 mb-2">Content Padding</p>
                                                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                                    {[
                                                        { key: 'c-pl', label: 'Left', value: localStandoutContentPaddingLeft, setter: setLocalStandoutContentPaddingLeft },
                                                        { key: 'c-pr', label: 'Right', value: localStandoutContentPaddingRight, setter: setLocalStandoutContentPaddingRight },
                                                        { key: 'c-pt', label: 'Top', value: localStandoutContentPaddingTop, setter: setLocalStandoutContentPaddingTop },
                                                        { key: 'c-pb', label: 'Bottom', value: localStandoutContentPaddingBottom, setter: setLocalStandoutContentPaddingBottom },
                                                    ].map(item => (
                                                        <div key={item.key} className="flex gap-2 items-center">
                                                            <input
                                                                type="number"
                                                                aria-label={`Standout content ${item.label.toLowerCase()} padding`}
                                                                value={isNaN(item.value) ? '' : item.value}
                                                                onChange={(e) => item.setter(parseInt(e.target.value))}
                                                                min="0"
                                                                max="200"
                                                                className="w-16 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                            />
                                                            <span className="text-xs text-secondary">{item.label} (px)</span>
                                                        </div>
                                                    ))}
                                                </div>
                                                <p className="text-sm font-semibold text-primary mt-4 mb-2">Border & Divider Settings</p>
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 gap-y-4">
                                                    {[
                                                        { key: 'standoutBorderColor', label: 'Border Color', value: localStandoutBorderColor, setter: setLocalStandoutBorderColor },
                                                        { key: 'standoutDividerColor', label: 'Divider Color', value: localStandoutDividerColor, setter: setLocalStandoutDividerColor }
                                                    ].map(item => (
                                                        <div key={item.key} className="flex gap-2 items-center">
                                                            <div className="w-6 h-6 rounded border border-outline shrink-0 flex items-center justify-center overflow-hidden relative" style={{ backgroundColor: item.value }}>
                                                                <input
                                                                    type="color"
                                                                    aria-label={`${item.label} picker`}
                                                                    value={item.value?.startsWith('#') ? item.value.slice(0, 7) : '#ffffff'}
                                                                    onChange={(e) => item.setter(e.target.value)}
                                                                    className="opacity-0 cursor-pointer w-10 h-10 absolute"
                                                                />
                                                            </div>
                                                            <input
                                                                type="text"
                                                                aria-label={`${item.label} hex color`}
                                                                value={item.value || ''}
                                                                onChange={(e) => item.setter(e.target.value)}
                                                                className="w-24 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                            />
                                                            <span className="text-xs text-secondary ml-1">{item.label}</span>
                                                        </div>
                                                    ))}
                                                    {[
                                                        { key: 'standoutBorderWidth', label: 'Border Width', value: localStandoutBorderWidth, setter: setLocalStandoutBorderWidth },
                                                        { key: 'standoutDividerWidth', label: 'Divider Width', value: localStandoutDividerWidth, setter: setLocalStandoutDividerWidth },
                                                        { key: 'standoutTitleFontSizeBase', label: 'Title Font Size (Base)', value: localStandoutTitleFontSizeBase, setter: setLocalStandoutTitleFontSizeBase },
                                                        { key: 'standoutTitleFontSizeStep', label: 'Title Font Size Step (per level)', value: localStandoutTitleFontSizeStep, setter: setLocalStandoutTitleFontSizeStep },
                                                        { key: 'standoutTitleFontSizeMin', label: 'Title Font Size (Min)', value: localStandoutTitleFontSizeMin, setter: setLocalStandoutTitleFontSizeMin },
                                                        { key: 'standoutBgLightenStep', label: 'Background Lighten Step (%)', value: localStandoutBgLightenStep, setter: setLocalStandoutBgLightenStep },
                                                        { key: 'standoutBgOpacityClosed', label: 'Background Opacity (Closed) %', value: localStandoutBgOpacityClosed, setter: setLocalStandoutBgOpacityClosed },
                                                        { key: 'standoutBgOpacityClosedHover', label: 'Background Opacity (Closed Hover) %', value: localStandoutBgOpacityClosedHover, setter: setLocalStandoutBgOpacityClosedHover },
                                                        { key: 'standoutBgOpacityOpen', label: 'Background Opacity (Open) %', value: localStandoutBgOpacityOpen, setter: setLocalStandoutBgOpacityOpen },
                                                        { key: 'standoutBgOpacityOpenHover', label: 'Background Opacity (Open Hover) %', value: localStandoutBgOpacityOpenHover, setter: setLocalStandoutBgOpacityOpenHover }
                                                    ].map(item => (
                                                        <div key={item.key} className="flex gap-2 items-center">
                                                            <input
                                                                type="number"
                                                                aria-label={item.label}
                                                                value={isNaN(item.value) ? '' : item.value}
                                                                onChange={(e) => item.setter(parseInt(e.target.value))}
                                                                className="w-16 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                            />
                                                            <span className="text-xs text-secondary">{item.label} (px)</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeTab === 'colors' && (
                            <div className="max-w-2xl">
                                <h3 className="text-base font-semibold text-primary mb-1">Math Visual</h3>
                                <p className="text-sm text-secondary mb-6">Configure raw LaTeX syntax colors and the spacing around displayed equations.</p>
                                
                                <div className="space-y-4">
                                    <div className="flex flex-col gap-2">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {[
                                                { key: 'mathHighlightColor', label: 'Default Text', value: localMathHighlightColor, setter: setLocalMathHighlightColor },
                                                { key: 'command', label: 'Commands (\\cmd)', value: localMathColors.command, setter: (val: string) => setLocalMathColors({...localMathColors, command: val}) },
                                                { key: 'brace', label: 'Braces ({})', value: localMathColors.brace, setter: (val: string) => setLocalMathColors({...localMathColors, brace: val}) },
                                                { key: 'script', label: 'Sub/Superscript (_^)', value: localMathColors.script, setter: (val: string) => setLocalMathColors({...localMathColors, script: val}) },
                                                { key: 'comment', label: 'Comments (%)', value: localMathColors.comment, setter: (val: string) => setLocalMathColors({...localMathColors, comment: val}) },
                                                { key: 'delimiter', label: 'Delimiters ($$ \\[)', value: localMathColors.delimiter, setter: (val: string) => setLocalMathColors({...localMathColors, delimiter: val}) },
                                                { key: 'align', label: 'Alignment (&)', value: localMathColors.align, setter: (val: string) => setLocalMathColors({...localMathColors, align: val}) },
                                                { key: 'escaped', label: 'Escaped (\\%)', value: localMathColors.escaped, setter: (val: string) => setLocalMathColors({...localMathColors, escaped: val}) }
                                            ].map(item => (
                                                <div key={item.key} className="flex gap-2 items-center">
                                                    <div className="w-6 h-6 rounded border border-outline shrink-0 flex items-center justify-center overflow-hidden relative" style={{ backgroundColor: item.value }}>
                                                        <input
                                                            type="color"
                                                            aria-label={`${item.label} picker`}
                                                            value={item.value?.startsWith('#') ? item.value.slice(0, 7) : '#000000'}
                                                            onChange={(e) => item.setter(e.target.value)}
                                                            className="opacity-0 cursor-pointer w-10 h-10 absolute"
                                                        />
                                                    </div>
                                                    <input
                                                        type="text"
                                                        aria-label={`${item.label} hex color`}
                                                        value={item.value || ''}
                                                        onChange={(e) => item.setter(e.target.value)}
                                                        className="w-24 bg-base border border-outline rounded px-2 py-1 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                                    />
                                                    <span className="text-xs text-secondary ml-1">{item.label}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-2 border-t border-outline pt-4">
                                        <label htmlFor="settings-math-padding" className="text-sm font-medium text-primary">Math Block Vertical Padding (px)</label>
                                        <div className="flex gap-2 items-center">
                                            <input
                                                id="settings-math-padding"
                                                type="number"
                                                value={localMathBlockPaddingY}
                                                onChange={(e) => setLocalMathBlockPaddingY(Number(e.target.value))}
                                                min="0"
                                                max="100"
                                                step="1"
                                                className="w-full max-w-xs bg-base border border-outline rounded px-3 py-2 text-sm font-mono text-primary focus:outline-none focus:border-accent"
                                            />
                                            <span className="text-xs text-secondary ml-2">Padding above and below block math equations.</span>
                                        </div>
                                    </div>
                                </div>
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
