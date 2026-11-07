// Shared, dependency-free note syntax and title presentation.
// The editor and the published reader import this file directly.
export function isEscaped(text, position) {
    let backslashes = 0;
    for (let i = position - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
    return backslashes % 2 === 1;
}

export function pairedDollarPositions(text) {
    const dollars = [];
    for (let i = 0; i < text.length; i++) if (text[i] === '$' && !isEscaped(text, i)) dollars.push(i);
    if (dollars.length % 2 === 1) dollars.pop();
    return new Set(dollars);
}

export function syntaxPositions(text) {
    const pairedDollars = pairedDollarPositions(text);
    const outside = new Set();
    let inMath = false;
    for (let i = 0; i < text.length; i++) {
        if (pairedDollars.has(i)) { inMath = !inMath; continue; }
        if (!inMath) outside.add(i);
    }
    return outside;
}

function decodeOutsideMathEscapes(text) {
    const outside = syntaxPositions(text);
    let decoded = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && outside.has(i) && i + 1 < text.length && '[]|@/∨$\\'.includes(text[i + 1])) decoded += text[++i];
        else decoded += text[i];
    }
    return decoded.normalize('NFC');
}

export function parseEmbeddedText(rawInput) {
    let text = rawInput.trim();
    let standout = false;
    if (text.startsWith('@')) { standout = true; text = text.slice(1); }
    let outside = syntaxPositions(text);
    let open = false;
    const last = text.length - 1;
    if (last >= 0 && text[last] === '∨' && outside.has(last) && !isEscaped(text, last)) {
        open = true; text = text.slice(0, -1).trimEnd(); outside = syntaxPositions(text);
    }
    let aliasIndex = -1;
    for (let i = 0; i < text.length - 1; i++) {
        if (text[i] === '|' && text[i + 1] === '|' && outside.has(i) && outside.has(i + 1) && !isEscaped(text, i)) { aliasIndex = i; break; }
    }
    const rawLabel = (aliasIndex === -1 ? text : text.slice(0, aliasIndex)).trim();
    const rawAlias = aliasIndex === -1 ? null : text.slice(aliasIndex + 2).trim();
    return {
        text: rawInput,
        label: decodeOutsideMathEscapes(rawLabel),
        alias: rawAlias === null ? null : decodeOutsideMathEscapes(rawAlias),
        standout, open, relative: rawLabel.startsWith('/')
    };
}

export function parseEmbeddedLinks(documentText) {
    const links = [];
    const documentMathDollars = new Set();
    let lineStart = 0;
    while (lineStart <= documentText.length) {
        const newline = documentText.indexOf('\n', lineStart);
        const lineEnd = newline === -1 ? documentText.length : newline;
        for (const position of pairedDollarPositions(documentText.slice(lineStart, lineEnd))) documentMathDollars.add(lineStart + position);
        if (newline === -1) break;
        lineStart = newline + 1;
    }
    let documentMath = false;
    for (let index = 0; index < documentText.length - 1; index++) {
        if (documentText[index] === '\n') { documentMath = false; continue; }
        if (documentMathDollars.has(index)) { documentMath = !documentMath; continue; }
        if (documentMath || documentText[index] !== '[' || documentText[index + 1] !== '[' || isEscaped(documentText, index)) continue;
        const innerStart = index + 2;
        const newline = documentText.indexOf('\n', innerStart);
        const limit = newline === -1 ? documentText.length : newline;
        const inner = documentText.slice(innerStart, limit);
        const pairedDollars = pairedDollarPositions(inner);
        let innerMath = false, close = -1;
        for (let offset = 0; offset < inner.length - 1; offset++) {
            if (pairedDollars.has(offset)) { innerMath = !innerMath; continue; }
            if (!innerMath && inner[offset] === ']' && inner[offset + 1] === ']' && !isEscaped(inner, offset)) {
                close = innerStart + offset; break;
            }
        }
        if (close === -1) continue;
        const rawText = documentText.slice(innerStart, close);
        links.push({from:index,to:close+2,rawText:documentText.slice(index,close+2),...parseEmbeddedText(rawText)});
        index = close + 1;
    }
    return links;
}

export function resolveEmbeddedLabel(parsed, parentLabel) {
    return parsed.relative ? parentLabel + parsed.label : parsed.label;
}

export function standoutDisplayTitle(title) {
    if (!title) return title;
    const first = title.match(/^./u)?.[0];
    return first && /^\p{Ll}$/u.test(first) ? first.toUpperCase() + title.slice(first.length) : title;
}

// Return text and TeX segments; the caller chooses KaTeX settings and markup.
export function splitMathTitle(text) {
    const segments = [];
    let current = 0, cursor = 0;
    const pushText = value => { if (value) segments.push({type: 'text', content: value.replace(/\\\$/g, '$')}); };
    while (cursor < text.length) {
        const delimiter = text[cursor] === '$' && !isEscaped(text, cursor) ? '$'
            : text.startsWith('\\[', cursor) && !isEscaped(text, cursor) ? '\\[' : null;
        if (!delimiter) { cursor++; continue; }
        const stop = delimiter === '$' ? '$' : '\\]';
        let close = cursor + delimiter.length;
        while ((close = text.indexOf(stop, close)) !== -1 && isEscaped(text, close)) close += stop.length;
        if (close === -1) { cursor++; continue; }
        const tex = text.slice(cursor + delimiter.length, close).trim();
        pushText(text.slice(current, cursor));
        if (tex) segments.push({type: 'math', content: tex});
        else pushText(text.slice(cursor, close + stop.length));
        current = close + stop.length; cursor = current;
    }
    pushText(text.slice(current));
    return segments;
}
