import { CompletionContext, snippetCompletion } from "@codemirror/autocomplete";
import { useStore } from "../../store";
import { latexCompletions } from "codemirror-lang-latex";
import { parsedRangesField } from "./katex-plugin";

// Standard Overleaf-style rich snippets that auto-place your cursor inside brackets
const latexSnippets = [
    snippetCompletion("\\frac{${}}{${}}", { label: "\\frac", detail: "fraction (num, den)" }),
    snippetCompletion("\\sqrt[${}]{${}}", { label: "\\sqrt", detail: "square root" }),
    snippetCompletion("\\sum_{${}}^{${}}", { label: "\\sum", detail: "summation (lower, upper)" }),
    snippetCompletion("\\int_{${}}^{${}}", { label: "\\int", detail: "integral (lower, upper)" }),
    snippetCompletion("\\prod_{${}}^{${}}", { label: "\\prod", detail: "product" }),
    snippetCompletion("\\lim_{${} \\to ${}}", { label: "\\lim", detail: "limit" }),
    // Environments
    snippetCompletion("\\begin{${matrix}}\n\t${}\n\\end{${matrix}}", { label: "\\begin", detail: "environment" })
];

const builtInCommands = [
    ...latexCompletions.environments.map(env => snippetCompletion(`\\begin{${env}}\n\t\${}\n\\end{${env}}`, { label: `\\begin{${env}}`, type: "keyword", detail: "environment" })),
    ...latexCompletions.mathCommands.map(cmd => ({ label: cmd, type: "keyword", detail: "math" })),
    ...latexCompletions.commands.map(cmd => ({ label: cmd, type: "keyword", detail: "command" }))
];

export function latexCompletion(context: CompletionContext) {
    const ranges = context.state.field(parsedRangesField, false);
    if (ranges) {
        const isInMath = ranges.some(r => (r.type === "inlineMath" || r.type === "blockMath") && context.pos >= r.from && context.pos <= r.to);
        if (!isInMath) return null;
    }

    const word = context.matchBefore(/\\[a-zA-Z]*(?:\{[a-zA-Z*]*)?$/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    // Get settings from store
    const settings = useStore.getState().settings;
    const macros = settings.macros || {};
    const customCommands = settings.customCommands || [];

    const macroOptions = Object.keys(macros).map(mac => ({
        label: mac,
        detail: "macro",
        type: "keyword"
    }));

    const customCommandOptions = customCommands.map(cmd => ({
        label: cmd,
        detail: "custom",
        type: "keyword"
    }));

    // Deduplicate options by label, preferring snippets
    const allOptions = [...latexSnippets, ...macroOptions, ...customCommandOptions, ...builtInCommands];
    const seen = new Set<string>();
    const uniqueOptions = allOptions.filter(opt => {
        if (seen.has(opt.label)) return false;
        seen.add(opt.label);
        return true;
    });

    return {
        from: word.from,
        options: uniqueOptions,
        validFor: /^\\[a-zA-Z]*(?:\{[a-zA-Z*]*)?$/
    };
}
