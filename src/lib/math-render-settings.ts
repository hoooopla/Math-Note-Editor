export type EmptySetStyle = 'standard' | 'slanted';

interface MathRenderSettings {
    macros?: Record<string, string>;
    emptySetStyle?: EmptySetStyle;
}

export function effectiveMathMacros(settings?: MathRenderSettings): Record<string, string> {
    const macros = settings?.macros || {};
    if (settings?.emptySetStyle !== 'slanted') return macros;
    return { ...macros, '\\emptyset': '\\varnothing' };
}
