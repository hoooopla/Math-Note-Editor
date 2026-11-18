/** Conservative source boundaries for recovering a failed KaTeX environment. */
export interface RecoveryRange { from: number; to: number }

const ROW_ENVIRONMENTS = new Set([
    'align', 'align*', 'alignat', 'alignat*', 'aligned', 'alignedat',
    'gather', 'gather*', 'gathered', 'flalign', 'flalign*', 'multline', 'multline*',
    'equation', 'equation*', 'split', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix',
    'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'dcases', 'array'
]);

interface EnvironmentRange { name: string; bodyFrom: number; bodyTo: number }

function environments(source: string): EnvironmentRange[] {
    const stack: { name: string; bodyFrom: number }[] = [];
    const found: EnvironmentRange[] = [];
    const pattern = /\\(begin|end)\{([^{}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        let slashes = 0;
        for (let i = match.index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
        if (slashes % 2) continue;
        if (match[1] === 'begin') stack.push({ name: match[2], bodyFrom: pattern.lastIndex });
        else if (stack.at(-1)?.name === match[2]) {
            const open = stack.pop()!;
            if (ROW_ENVIRONMENTS.has(open.name)) found.push({
                name: open.name, bodyFrom: open.bodyFrom, bodyTo: match.index
            });
        } else return [];
    }
    return stack.length ? [] : found;
}

function segments(source: string, range: RecoveryRange, kind: 'row' | 'cell' | 'piece'): RecoveryRange[] {
    const result: RecoveryRange[] = [];
    let start = range.from;
    let braces = 0;
    let nested = 0;
    const add = (end: number) => {
        let from = start;
        let to = end;
        while (from < to && /\s/.test(source[from])) from++;
        while (to > from && /\s/.test(source[to - 1])) to--;
        if (from < to) result.push({ from, to });
    };
    for (let i = range.from; i < range.to; i++) {
        if (source[i] === '\\') {
            if (source[i + 1] === '\\') {
                if (kind === 'row' && !braces && !nested) {
                    add(i);
                    i++;
                    if (source[i + 1] === '[') {
                        const close = source.indexOf(']', i + 2);
                        if (close >= 0 && close < range.to) i = close;
                    }
                    start = i + 1;
                } else i++;
                continue;
            }
            const environment = /^\\(begin|end)\{([^{}]+)\}/.exec(source.slice(i));
            if (environment) {
                nested += environment[1] === 'begin' ? 1 : -1;
                i += environment[0].length - 1;
                continue;
            }
            const command = /^\\[A-Za-z]+|^\\./.exec(source.slice(i));
            if (command) i += command[0].length - 1;
            continue;
        }
        if (source[i] === '{') braces++;
        else if (source[i] === '}') braces--;
        if (braces || nested) continue;
        if (kind === 'cell' && source[i] === '&') {
            add(i);
            start = i + 1;
        } else if (kind === 'piece' && /[+=-]/.test(source[i])) {
            add(i);
            start = i + 1;
        }
    }
    add(range.to);
    return result;
}

/** Smallest syntactic regions first; the renderer must validate every substitution. */
export function recoveryCandidates(source: string, hint = source.length): RecoveryRange[] {
    if (source.length > 20_000) return [];
    const all = new Map<string, RecoveryRange>();
    for (const piece of segments(source, { from: 0, to: source.length }, 'piece')) {
        if (piece.to - piece.from < source.trim().length) all.set(`${piece.from}:${piece.to}`, piece);
    }
    for (const environment of environments(source)) {
        const body = { from: environment.bodyFrom, to: environment.bodyTo };
        const rows = segments(source, body, 'row');
        for (const row of rows) {
            all.set(`${row.from}:${row.to}`, row);
            for (const cell of segments(source, row, 'cell')) {
                all.set(`${cell.from}:${cell.to}`, cell);
                for (const piece of segments(source, cell, 'piece')) all.set(`${piece.from}:${piece.to}`, piece);
            }
        }
    }
    const distance = (range: RecoveryRange) => hint < range.from ? range.from - hint
        : hint > range.to ? hint - range.to : 0;
    return [...all.values()].filter(range => range.to - range.from < source.trim().length)
        .sort((a, b) => distance(a) - distance(b) ||
        (a.to - a.from) - (b.to - b.from) || b.from - a.from);
}
