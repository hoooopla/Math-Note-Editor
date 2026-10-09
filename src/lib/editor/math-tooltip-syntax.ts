export interface MathExplanation {
    from: number;
    to: number;
    math: string;
    content: string;
    contentFrom: number;
    contentTo: number;
}

function escaped(source: string, position: number) {
    let slashes = 0;
    for (let at = position - 1; at >= 0 && source[at] === "\\"; at--) slashes++;
    return slashes % 2 === 1;
}

function argument(source: string, start: number) {
    if (source[start] !== "{") return null;
    let depth = 1;
    for (let at = start + 1; at < source.length; at++) {
        if (escaped(source, at)) continue;
        if (source[at] === "{") depth++;
        if (source[at] === "}" && --depth === 0) {
            return { from: start + 1, to: at, end: at + 1 };
        }
    }
    return null;
}

/** Find complete commands only. Source positions stay valid in the editor. */
export function parseMathExplanations(source: string): MathExplanation[] {
    const found: MathExplanation[] = [];
    for (let at = 0; at < source.length; at++) {
        if (!source.startsWith("\\tooltip", at) || escaped(source, at) || /[A-Za-z]/.test(source[at + 8] || "")) continue;
        let next = at + 8;
        while (/[ \t]/.test(source[next] || "")) next++;
        const math = argument(source, next);
        if (!math) continue;
        next = math.end;
        while (/[ \t]/.test(source[next] || "")) next++;
        const content = argument(source, next);
        if (!content || !source.slice(math.from, math.to).trim()) continue;
        found.push({ from: at, to: content.end, math: source.slice(math.from, math.to),
            content: source.slice(content.from, content.to), contentFrom: content.from, contentTo: content.to });
        at = content.end - 1;
    }
    return found;
}

/** Hide explanation delimiters while preserving positions and line breaks. */
export function maskMathExplanations(source: string) {
    const chars = source.split("");
    const explanations = parseMathExplanations(source);
    let next = 0;
    let inDisplay = false;
    let inInline = false;
    for (let at = 0; at < source.length; at++) {
        if (source[at] === "\n" && !inDisplay) inInline = false;
        if (!inInline && source.startsWith("\\[", at) && !escaped(source, at)) {
            inDisplay = true;
            at++;
            continue;
        }
        if (inDisplay && source.startsWith("\\]", at) && !escaped(source, at)) {
            inDisplay = false;
            at++;
            continue;
        }
        if (!inDisplay && source[at] === "$" && !escaped(source, at)) {
            inInline = !inInline;
            continue;
        }
        const explanation = explanations[next];
        if (explanation?.from !== at) continue;
        next++;
        if (inDisplay || inInline) {
            for (let position = explanation.contentFrom; position < explanation.contentTo; position++) {
                if (chars[position] !== "\n") chars[position] = "x";
            }
            if (inInline && explanation.content.includes("\n")) inInline = false;
        }
        at = explanation.to - 1;
    }
    return chars.join("");
}

export function prepareExplainedMath(source: string) {
    const explanations = parseMathExplanations(source);
    if (!explanations.length) return { tex: source, explanations: [] as Array<MathExplanation & { id: string }> };
    const nonce = Math.random().toString(36).slice(2);
    const marked = explanations.map((item, index) => ({ ...item, id: `${nonce}-${index}` }));
    let tex = "";
    let cursor = 0;
    for (const item of marked) {
        tex += source.slice(cursor, item.from);
        tex += `\\htmlData{math-tooltip-id=${item.id}}{${item.math}}`;
        cursor = item.to;
    }
    tex += source.slice(cursor);
    return { tex, explanations: marked };
}
