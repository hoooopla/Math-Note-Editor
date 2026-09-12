export interface EmbeddedLinkSyntax {
    from: number;
    to: number;
    rawText: string;
    text: string;
    label: string;
    alias: string | null;
    standout: boolean;
    open: boolean;
    relative: boolean;
}

export interface ActiveEmbeddedTarget {
    from: number;
    to: number;
    label: string;
    relative: boolean;
    standout: boolean;
}

function isEscaped(text: string, position: number): boolean {
    let backslashes = 0;
    for (let index = position - 1; index >= 0 && text[index] === "\\"; index--) backslashes++;
    return backslashes % 2 === 1;
}

function pairedDollarPositions(text: string): Set<number> {
    const dollars: number[] = [];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "$" && !isEscaped(text, index)) dollars.push(index);
    }
    if (dollars.length % 2 === 1) dollars.pop();
    return new Set(dollars);
}

function syntaxPositions(text: string): Set<number> {
    const pairedDollars = pairedDollarPositions(text);
    const outsideMath = new Set<number>();
    let inMath = false;
    for (let index = 0; index < text.length; index++) {
        if (pairedDollars.has(index)) {
            inMath = !inMath;
            continue;
        }
        if (!inMath) outsideMath.add(index);
    }
    return outsideMath;
}

function decodeOutsideMathEscapes(text: string): string {
    const outsideMath = syntaxPositions(text);
    let decoded = "";
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\\" && outsideMath.has(index) && index + 1 < text.length && "[]|@/∨$\\".includes(text[index + 1])) {
            decoded += text[++index];
        } else {
            decoded += text[index];
        }
    }
    return decoded.normalize("NFC");
}

export function parseEmbeddedText(rawInput: string): Omit<EmbeddedLinkSyntax, "from" | "to" | "rawText"> {
    let text = rawInput.trim();
    let standout = false;
    if (text.startsWith("@")) {
        standout = true;
        text = text.slice(1);
    }

    let outsideMath = syntaxPositions(text);
    let open = false;
    const lastIndex = text.length - 1;
    if (lastIndex >= 0 && text[lastIndex] === "∨" && outsideMath.has(lastIndex) && !isEscaped(text, lastIndex)) {
        open = true;
        text = text.slice(0, -1).trimEnd();
        outsideMath = syntaxPositions(text);
    }

    let aliasIndex = -1;
    for (let index = 0; index < text.length - 1; index++) {
        if (text[index] === "|" && text[index + 1] === "|" && outsideMath.has(index) && outsideMath.has(index + 1) && !isEscaped(text, index)) {
            aliasIndex = index;
            break;
        }
    }

    const rawLabel = (aliasIndex === -1 ? text : text.slice(0, aliasIndex)).trim();
    const rawAlias = aliasIndex === -1 ? null : text.slice(aliasIndex + 2).trim();
    const relative = rawLabel.startsWith("/");
    return {
        text: rawInput,
        label: decodeOutsideMathEscapes(rawLabel),
        alias: rawAlias === null ? null : decodeOutsideMathEscapes(rawAlias),
        standout,
        open,
        relative
    };
}

export function parseEmbeddedLinks(documentText: string): EmbeddedLinkSyntax[] {
    const links: EmbeddedLinkSyntax[] = [];
    const documentMathDollars = new Set<number>();
    let lineStart = 0;
    while (lineStart <= documentText.length) {
        const newline = documentText.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? documentText.length : newline;
        for (const position of pairedDollarPositions(documentText.slice(lineStart, lineEnd))) {
            documentMathDollars.add(lineStart + position);
        }
        if (newline === -1) break;
        lineStart = newline + 1;
    }
    let documentMath = false;
    for (let index = 0; index < documentText.length - 1; index++) {
        const character = documentText[index];
        if (character === "\n") {
            documentMath = false;
            continue;
        }
        if (documentMathDollars.has(index)) {
            documentMath = !documentMath;
            continue;
        }
        if (documentMath || character !== "[" || documentText[index + 1] !== "[" || isEscaped(documentText, index)) continue;

        const innerStart = index + 2;
        const lineEnd = documentText.indexOf("\n", innerStart);
        const limit = lineEnd === -1 ? documentText.length : lineEnd;
        const inner = documentText.slice(innerStart, limit);
        const pairedDollars = pairedDollarPositions(inner);
        let innerMath = false;
        let close = -1;
        for (let offset = 0; offset < inner.length - 1; offset++) {
            if (pairedDollars.has(offset)) {
                innerMath = !innerMath;
                continue;
            }
            if (!innerMath && inner[offset] === "]" && inner[offset + 1] === "]" && !isEscaped(inner, offset)) {
                close = innerStart + offset;
                break;
            }
        }
        if (close === -1) continue;

        const rawText = documentText.slice(innerStart, close);
        links.push({
            from: index,
            to: close + 2,
            rawText: documentText.slice(index, close + 2),
            ...parseEmbeddedText(rawText)
        });
        index = close + 1;
    }
    return links;
}

export function resolveEmbeddedLabel(parsed: Pick<EmbeddedLinkSyntax, "label" | "relative">, parentLabel: string): string {
    return parsed.relative ? parentLabel + parsed.label : parsed.label;
}

export function setEmbeddedOpen(rawText: string, open: boolean): string {
    const parsed = parseEmbeddedText(rawText);
    if (parsed.open === open) return rawText;
    if (open) return `${rawText.trimEnd()}∨`;
    const trimmed = rawText.trimEnd();
    return trimmed.endsWith("∨") ? trimmed.slice(0, -1) : rawText;
}

export function encodeEmbeddedLabel(label: string, options: { relative?: boolean; standout?: boolean } = {}): string {
    const pairedDollars = pairedDollarPositions(label);
    let inMath = false;
    let encoded = "";
    for (let index = 0; index < label.length; index++) {
        const character = label[index];
        if (pairedDollars.has(index)) {
            inMath = !inMath;
            encoded += character;
            continue;
        }
        if (inMath) {
            encoded += character;
            continue;
        }

        const isStructuralPair = (character === "|" && (label[index - 1] === "|" || label[index + 1] === "|")) ||
            (character === "[" && (label[index - 1] === "[" || label[index + 1] === "[")) ||
            (character === "]" && (label[index - 1] === "]" || label[index + 1] === "]"));
        const isSpecialEdge = (index === 0 && (character === "@" || character === "/")) ||
            (index === label.length - 1 && (character === "∨" || character === "]"));
        if (character === "\\" || character === "$" || isStructuralPair || isSpecialEdge) encoded += "\\";
        encoded += character;
    }
    const withRelativeMarker = options.relative ? encoded.replace(/^\\?\//, "/") : encoded;
    return `${options.standout ? "@" : ""}${withRelativeMarker}`;
}

export function targetBounds(rawText: string): { start: number; end: number } {
    const start = rawText.startsWith("@") ? 1 : 0;
    const outsideMath = syntaxPositions(rawText);
    let end = rawText.length;
    for (let index = start; index < rawText.length - 1; index++) {
        if (rawText[index] === "|" && rawText[index + 1] === "|" && outsideMath.has(index) && outsideMath.has(index + 1) && !isEscaped(rawText, index)) {
            end = index;
            break;
        }
    }
    if (end === rawText.length) {
        const last = rawText.length - 1;
        if (last >= start && rawText[last] === "∨" && outsideMath.has(last) && !isEscaped(rawText, last)) end = last;
    }
    return { start, end };
}

export function findActiveEmbeddedTarget(
    documentText: string,
    position: number,
    options: { allowUnclosed?: boolean } = {}
): ActiveEmbeddedTarget | null {
    const lineStart = documentText.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
    const nextNewline = documentText.indexOf("\n", position);
    const lineEnd = nextNewline === -1 ? documentText.length : nextNewline;
    const line = documentText.slice(lineStart, lineEnd);
    const localPosition = position - lineStart;

    for (const link of parseEmbeddedLinks(line)) {
        if (localPosition < link.from + 2 || localPosition > link.to - 2) continue;
        const bounds = targetBounds(link.text);
        const targetFrom = link.from + 2 + bounds.start;
        const targetTo = link.from + 2 + bounds.end;
        if (localPosition > targetTo) return null;
        const parsed = parseEmbeddedText(link.text.slice(bounds.start, bounds.end));
        return {
            from: lineStart + targetFrom,
            to: lineStart + targetTo,
            label: parsed.label,
            relative: parsed.relative,
            standout: link.standout
        };
    }

    if (options.allowUnclosed === false) return null;

    // Some editor interactions still need to recognize an unfinished [[target.
    const prefix = line.slice(0, localPosition);
    const opener = prefix.lastIndexOf("[[");
    if (opener === -1 || prefix.lastIndexOf("]]") > opener) return null;
    const rawText = line.slice(opener + 2);
    const bounds = targetBounds(rawText);
    const targetFrom = opener + 2 + bounds.start;
    const targetTo = opener + 2 + bounds.end;
    if (localPosition < targetFrom || localPosition > targetTo) return null;
    const parsed = parseEmbeddedText(rawText.slice(bounds.start, bounds.end));
    return {
        from: lineStart + targetFrom,
        to: lineStart + targetTo,
        label: parsed.label,
        relative: parsed.relative,
        standout: rawText.startsWith("@")
    };
}
