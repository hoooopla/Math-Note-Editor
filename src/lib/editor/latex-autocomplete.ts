import { CompletionContext, snippetCompletion } from "@codemirror/autocomplete";
import { useStore } from "../../store";
import { latexCompletions } from "codemirror-lang-latex";

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
    ...latexCompletions.mathCommands.map(cmd => ({ label: cmd, type: "keyword", detail: "math" })),
    ...latexCompletions.commands.map(cmd => ({ label: cmd, type: "keyword", detail: "command" })),
    ...latexCompletions.environments.map(env => ({ label: `\\begin{${env}}`, type: "keyword", detail: "environment" }))
];

export function latexCompletion(context: CompletionContext) {
    const word = context.matchBefore(/\\[a-zA-Z]*$/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    // Get custom macros from store
    const macros = useStore.getState().macros;
    const macroOptions = Object.keys(macros).map(mac => ({
        label: mac,
        detail: "macro",
        type: "keyword"
    }));

    // Deduplicate options by label, preferring snippets
    const allOptions = [...latexSnippets, ...macroOptions, ...builtInCommands];
    const seen = new Set<string>();
    const uniqueOptions = allOptions.filter(opt => {
        if (seen.has(opt.label)) return false;
        seen.add(opt.label);
        return true;
    });

    return {
        from: word.from,
        options: uniqueOptions,
        validFor: /^\\[a-zA-Z]*$/
    };
}
