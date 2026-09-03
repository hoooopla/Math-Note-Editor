import { Completion, CompletionContext, pickedCompletion, snippetCompletion } from "@codemirror/autocomplete";
import { useStore } from "../../store";
import { latexCompletions } from "codemirror-lang-latex";
import { parsedRangesField } from "./katex-plugin";

// Standard Overleaf-style rich snippets that auto-place your cursor inside brackets
const inlineMathSnippets = [
    snippetCompletion("\\frac{${}}{${}}", { label: "\\frac", detail: "fraction (num, den)" }),
    snippetCompletion("\\sqrt{${}}", { label: "\\sqrt", detail: "square root" }),
    snippetCompletion("\\sqrt[${}]{${}}", { label: "\\sqrt[]" }),
    snippetCompletion("\\sum_{${}}^{${}}", { label: "\\sum", detail: "summation (lower, upper)" }),
    snippetCompletion("\\int_{${}}^{${}}", { label: "\\int", detail: "integral (lower, upper)" }),
    snippetCompletion("\\prod_{${}}^{${}}", { label: "\\prod", detail: "product" }),
    snippetCompletion("\\lim_{${} \\to ${}}", { label: "\\lim", detail: "limit" }),
    snippetCompletion("\\binom{${}}{${}}", { label: "\\binom" }),
    snippetCompletion("\\vec{${}}", { label: "\\vec" }),
    snippetCompletion("\\hat{${}}", { label: "\\hat" }),
    snippetCompletion("\\overline{${}}", { label: "\\overline" }),
    snippetCompletion("\\mathbb{${}}", { label: "\\mathbb" }),
    snippetCompletion("\\mathcal{${}}", { label: "\\mathcal" }),
    snippetCompletion("\\text{${}}", { label: "\\text" }),
    snippetCompletion("\\operatorname{${}}", { label: "\\operatorname" }),
    snippetCompletion("\\left(${})\\right)", { label: "\\left(" }),
    snippetCompletion("\\left\\lVert ${} \\right\\rVert", { label: "\\lVert…\\rVert" }),
    snippetCompletion("\\left\\{ ${} \\mid ${} \\right\\}", { label: "\\{…\\mid…\\}" }),
    snippetCompletion("\\frac{d ${}}{d ${x}}", { label: "\\frac d/dx" }),
    snippetCompletion("\\frac{\\partial ${}}{\\partial ${x}}", { label: "\\frac partial" })
];

const displayMathSnippets = [
    snippetCompletion("\\begin{aligned}\n\t${} &= ${} \\\\\n\\end{aligned}", { label: "\\begin{aligned}" }),
    snippetCompletion("\\begin{cases}\n\t${} & ${} \\\\\n\t${} & ${}\n\\end{cases}", { label: "\\begin{cases}" }),
    snippetCompletion("\\begin{pmatrix}\n\t${} & ${} \\\\\n\t${} & ${}\n\\end{pmatrix}", { label: "\\begin{pmatrix}" }),
    snippetCompletion("\\begin{bmatrix}\n\t${} & ${} \\\\\n\t${} & ${}\n\\end{bmatrix}", { label: "\\begin{bmatrix}" })
];

const builtInCommands: Completion[] = [
    ...latexCompletions.mathCommands
        .filter(cmd => !/^\\(?:begin|end)\{/.test(cmd))
        .map(cmd => ({ label: cmd, type: "keyword", detail: "math" })),
    ...latexCompletions.commands
        .filter(cmd => cmd !== "\\begin" && cmd !== "\\end")
        .map(cmd => ({ label: cmd, type: "keyword", detail: "command" }))
];

const environmentCompletions = latexCompletions.environments.map(env =>
    snippetCompletion(`\\begin{${env}}\n\t\${}\n\\end{${env}}`, {
        label: `\\begin{${env}}`,
        type: "keyword",
        detail: "environment"
    })
);

const completionUsage = new Map<string, number>();
let completionUsageRevision = 0;
let cachedBaseKey = "";
let cachedBaseOptions: Completion[] = [];
let cachedRankedKey = "";
let cachedRankedRevision = -1;
let cachedRankedOptions: Completion[] = [];

function applyCompletion(view: Parameters<NonNullable<Extract<Completion["apply"], Function>>>[0], completion: Completion, from: number, to: number) {
    const originalApply = completion.apply;
    if (typeof originalApply === "function") {
        originalApply(view, completion, from, to);
        return;
    }

    const insert = typeof originalApply === "string" ? originalApply : completion.label;
    view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        annotations: pickedCompletion.of(completion)
    });
}

function getCompletionOptions(macros: Record<string, string>, customCommands: string[], includeEnvironments: boolean) {
    const settingsKey = JSON.stringify([Object.keys(macros), customCommands, includeEnvironments]);
    if (settingsKey !== cachedBaseKey) {
        const macroOptions: Completion[] = Object.keys(macros).map(label => ({ label, type: "keyword", detail: "macro" }));
        const customCommandOptions: Completion[] = customCommands.map(label => ({ label, type: "keyword", detail: "custom" }));
        const candidates = [
            ...inlineMathSnippets,
            ...(includeEnvironments ? displayMathSnippets : []),
            ...macroOptions,
            ...customCommandOptions,
            ...builtInCommands,
            ...(includeEnvironments ? environmentCompletions : [])
        ];

        const seen = new Set<string>();
        cachedBaseOptions = candidates.filter(option => {
            if (seen.has(option.label)) return false;
            seen.add(option.label);
            return true;
        });
        cachedBaseKey = settingsKey;
        cachedRankedKey = "";
    }

    if (cachedRankedKey !== settingsKey || cachedRankedRevision !== completionUsageRevision) {
        cachedRankedOptions = cachedBaseOptions.map(option => ({
            ...option,
            boost: (option.boost || 0) + Math.min(50, (completionUsage.get(option.label) || 0) * 5),
            apply(view, selected, from, to) {
                completionUsage.set(option.label, (completionUsage.get(option.label) || 0) + 1);
                completionUsageRevision++;
                applyCompletion(view, option, from, to);
            }
        }));
        cachedRankedKey = settingsKey;
        cachedRankedRevision = completionUsageRevision;
    }

    return cachedRankedOptions;
}

export function latexCompletion(context: CompletionContext) {
    const ranges = context.state.field(parsedRangesField, false);
    let activeMathType: "inlineMath" | "blockMath" | null = null;
    if (ranges) {
        const activeMathRange = ranges.find(r => {
            if (r.type !== "inlineMath" && r.type !== "blockMath") return false;

            const delimiterWidth = r.type === "inlineMath" ? 1 : 2;
            const contentFrom = r.from + delimiterWidth;
            const contentTo = r.to - delimiterWidth;
            return context.pos >= contentFrom && context.pos <= contentTo;
        });
        if (!activeMathRange || (activeMathRange.type !== "inlineMath" && activeMathRange.type !== "blockMath")) return null;
        activeMathType = activeMathRange.type;
    }

    const word = context.matchBefore(/\\[a-zA-Z]*(?:\{[a-zA-Z*]*)?$/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    let backslashesBefore = 0;
    for (let i = word.from - 1; i >= 0; i--) {
        if (context.state.doc.sliceString(i, i + 1) === "\\") {
            backslashesBefore++;
        } else {
            break;
        }
    }

    if (backslashesBefore % 2 !== 0) {
        return null;
    }

    const afterStr = context.state.doc.sliceString(context.pos, Math.min(context.pos + 50, context.state.doc.length));
    const hasBrace = word.text.includes("{");
    const wordAfterMatch = hasBrace ? afterStr.match(/^[a-zA-Z]*\}?/) : afterStr.match(/^[a-zA-Z]*/);
    const to = context.pos + (wordAfterMatch ? wordAfterMatch[0].length : 0);

    // Get settings from store
    const settings = useStore.getState().settings;
    const macros = settings.macros || {};
    const customCommands = settings.customCommands || [];

    return {
        from: word.from,
        to: to,
        options: getCompletionOptions(macros, customCommands, activeMathType === "blockMath"),
        validFor: /^\\[a-zA-Z]*(?:\{[a-zA-Z*]*)?$/
    };
}
