import { CompletionContext, snippetCompletion } from "@codemirror/autocomplete";
import { useStore } from "../../store";

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

// Standard keywords
const latexKeywords = [
    "alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "pi", "sigma", "omega",
    "leftarrow", "rightarrow", "uparrow", "downarrow",
    "approx", "neq", "leq", "geq", "cdot", "times",
    "sin", "cos", "tan", "log", "ln"
].map(cmd => ({ label: "\\" + cmd, type: "keyword" }));

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

    return {
        from: word.from,
        options: [...latexSnippets, ...latexKeywords, ...macroOptions],
        validFor: /^\\[a-zA-Z]*$/
    };
}
