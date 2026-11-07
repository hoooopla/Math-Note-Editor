import type { EditorSettings, WorkspaceSession } from '../store/api';

const colorPattern = /^#[0-9a-f]{6}$/i;
const shortcutKeys = [
    'searchShortcut', 'insertImageShortcut', 'editMetadataShortcut', 'goToParentShortcut',
    'closeTabShortcut', 'reopenClosedTabShortcut', 'nextTabShortcut', 'previousTabShortcut'
] as const;
const colorKeys = [
    'inlineBlockTitleColorWithContent', 'inlineBlockTitleColorEmpty',
    'standoutBlockTitleColorWithContent', 'standoutBlockTitleColorEmpty',
    'standoutBlockBorderColor', 'standoutBlockDividerColor', 'mathHighlightColor'
] as const;
const numberRanges = {
    outlineDockWidth: [500, 1600], inlineBlockTitleUnderlineOpacity: [0, 100],
    inlineBlockIndentWidth: [0, 200], standoutBlockIndentWidth: [0, 200],
    standoutBlockTitlePaddingLeft: [0, 200], standoutBlockTitlePaddingRight: [0, 200],
    standoutBlockTitlePaddingTop: [0, 200], standoutBlockTitlePaddingBottom: [0, 200],
    standoutBlockContentPaddingLeft: [0, 200], standoutBlockContentPaddingRight: [0, 200],
    standoutBlockContentPaddingTop: [0, 200], standoutBlockContentPaddingBottom: [0, 200],
    standoutBlockBorderWidth: [0, 20], standoutBlockDividerWidth: [0, 20],
    standoutBlockTitleFontSizeBase: [8, 96], standoutBlockTitleFontSizeStep: [0, 24],
    standoutBlockTitleFontSizeMin: [8, 96], standoutBlockBgLightenStep: [0, 100],
    standoutBlockBgOpacityClosed: [0, 100], standoutBlockBgOpacityClosedHover: [0, 100],
    standoutBlockBgOpacityOpen: [0, 100], standoutBlockBgOpacityOpenHover: [0, 100],
    mathBlockPaddingY: [0, 100]
} as const;
const mathColorKeys = ['command', 'brace', 'script', 'comment', 'delimiter', 'align', 'escaped'] as const;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidSettingsShortcut(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parts = value.toLowerCase().split('+').map(part => part.trim()).filter(Boolean);
    if (parts.length === 1 && /^f(?:[1-9]|1[0-2])$/.test(parts[0])) return true;
    const modifiers = parts.slice(0, -1);
    return parts.length >= 2
        && modifiers.every(modifier => ['ctrl', 'meta', 'cmd', 'mod', 'shift', 'alt'].includes(modifier))
        && modifiers.some(modifier => ['ctrl', 'meta', 'cmd', 'mod'].includes(modifier))
        && new Set(modifiers).size === modifiers.length
        && /^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|tab|enter|space|escape|backspace|delete|arrow(?:up|down|left|right)|\/)$/
            .test(parts.at(-1) || '');
}

/** Validate supplied fields while allowing settings written by older versions to omit new fields. */
export function validateEditorSettings(raw: unknown): string[] {
    if (!record(raw)) return ['Settings must be a JSON object.'];
    const issues: string[] = [];
    if ('macros' in raw && (!record(raw.macros) || Object.values(raw.macros).some(value => typeof value !== 'string')))
        issues.push('Math macros must be an object of text replacements.');
    for (const key of ['customCommands', 'textCommands'] as const) {
        if (key in raw && (!Array.isArray(raw[key]) || raw[key].some(value => typeof value !== 'string')))
            issues.push(`${key} must be a list of text commands.`);
    }
    for (const key of shortcutKeys) {
        if (key in raw && !isValidSettingsShortcut(raw[key])) issues.push(`${key} must be a valid keyboard shortcut.`);
    }
    for (const key of colorKeys) {
        if (key in raw && (typeof raw[key] !== 'string' || !colorPattern.test(raw[key])))
            issues.push(`${key} must be a six-digit hex color.`);
    }
    for (const [key, [min, max]] of Object.entries(numberRanges)) {
        if (key in raw && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max))
            issues.push(`${key} must be between ${min} and ${max}.`);
    }
    if ('mathColors' in raw) {
        if (!record(raw.mathColors)) issues.push('mathColors must be an object of hex colors.');
        else for (const key of mathColorKeys) {
            const color = raw.mathColors[key];
            if (color !== undefined && (typeof color !== 'string' || !colorPattern.test(color)))
                issues.push(`mathColors.${key} must be a six-digit hex color.`);
        }
    }
    if ('emptySetStyle' in raw && raw.emptySetStyle !== 'standard' && raw.emptySetStyle !== 'slanted')
        issues.push('emptySetStyle must be standard or slanted.');
    if ('workspaceSession' in raw && raw.workspaceSession !== undefined) {
        const session = raw.workspaceSession;
        if (!record(session) || !Array.isArray(session.openTabs) || session.openTabs.some(id => typeof id !== 'string') ||
            (session.activeTab !== null && typeof session.activeTab !== 'string') ||
            (session.lockedTabs !== undefined && (!Array.isArray(session.lockedTabs) || session.lockedTabs.some(id => typeof id !== 'string'))))
            issues.push('workspaceSession must contain tab IDs and an active tab.');
    }
    return issues;
}

/** Keep good preferences in use while leaving the original file untouched for recovery. */
export function normalizeEditorSettings(raw: unknown, defaults: EditorSettings): { settings: EditorSettings; issues: string[] } {
    const issues = validateEditorSettings(raw);
    if (!record(raw)) return { settings: defaults, issues };
    const settings: EditorSettings = { ...defaults };
    if (record(raw.macros) && Object.values(raw.macros).every(value => typeof value === 'string')) settings.macros = raw.macros as Record<string, string>;
    if (Array.isArray(raw.customCommands) && raw.customCommands.every(value => typeof value === 'string')) settings.customCommands = raw.customCommands;
    if (Array.isArray(raw.textCommands) && raw.textCommands.every(value => typeof value === 'string')) settings.textCommands = raw.textCommands;
    for (const key of shortcutKeys) if (isValidSettingsShortcut(raw[key])) settings[key] = raw[key];
    for (const key of colorKeys) if (typeof raw[key] === 'string' && colorPattern.test(raw[key])) settings[key] = raw[key];
    for (const [key, [min, max]] of Object.entries(numberRanges)) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
            (settings as unknown as Record<string, unknown>)[key] = value;
    }
    if (record(raw.mathColors)) {
        const mathColors = { ...defaults.mathColors! };
        for (const key of mathColorKeys) if (typeof raw.mathColors[key] === 'string' && colorPattern.test(raw.mathColors[key])) mathColors[key] = raw.mathColors[key];
        settings.mathColors = mathColors;
    }
    if (raw.emptySetStyle === 'standard' || raw.emptySetStyle === 'slanted') settings.emptySetStyle = raw.emptySetStyle;
    if (record(raw.workspaceSession) && !validateEditorSettings({ workspaceSession: raw.workspaceSession }).length)
        settings.workspaceSession = raw.workspaceSession as unknown as WorkspaceSession;
    return { settings, issues };
}
