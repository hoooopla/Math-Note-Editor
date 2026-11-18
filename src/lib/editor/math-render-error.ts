import katex from 'katex';

export type MathRenderEngine = 'katex' | 'tikz';

export interface MathRenderDiagnostic {
    title: string;
    message: string;
    excerpt?: { before: string; error: string; after: string };
    sourceRange?: { from: number; to: number };
}

export function mathRenderDiagnostic(
    error: unknown,
    source: string,
    engine: MathRenderEngine,
    positionMatchesSource = true
): MathRenderDiagnostic {
    if (engine === 'tikz') {
        const detail = error instanceof Error ? error.message : String(error);
        if (/timed out/i.test(detail)) return {
            title: 'Diagram timed out',
            message: 'Rendering took too long. Check for a complex or incomplete diagram.'
        };
        if (/macros are too large/i.test(detail)) return {
            title: 'Diagram macros are too large',
            message: 'Shorten the saved math macros used by this diagram.'
        };
        if (/missing TeX font/i.test(detail)) return {
            title: 'Diagram font unavailable', message: detail
        };
        return {
            title: 'Diagram could not compile',
            message: 'Check the diagram commands, arrow options, and saved macros. The renderer did not report an exact location.'
        };
    }

    const parseError = error instanceof katex.ParseError ? error : undefined;
    const message = parseError?.rawMessage || (error instanceof Error ? error.message : String(error));
    const position = parseError?.position;
    if (!positionMatchesSource || typeof position !== 'number' || position < 0 || position > source.length) {
        return { title: 'Math could not render', message };
    }
    const length = position === source.length ? 0 : Math.max(1, Math.min(parseError.length || 1, source.length - position));
    const lineStart = source.lastIndexOf('\n', position - 1) + 1;
    const lineEndIndex = source.indexOf('\n', position);
    const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
    const start = Math.max(lineStart, position - 32);
    const end = Math.min(lineEnd, position + length + 42);
    return {
        title: 'Math could not render',
        message,
        sourceRange: { from: position, to: position + length },
        excerpt: {
            before: `${start > lineStart ? '…' : ''}${source.slice(start, position)}`,
            error: length ? source.slice(position, Math.min(position + length, end)) : 'end of formula',
            after: `${source.slice(Math.min(position + length, end), end)}${end < lineEnd ? '…' : ''}`
        }
    };
}

export function renderMathError(
    host: HTMLElement,
    diagnostic: MathRenderDiagnostic,
    displayMode: boolean,
    editable: boolean,
    onEdit?: (event: Event) => void
) {
    const card = document.createElement(displayMode ? 'div' : 'span');
    card.className = `cm-math-render-error${displayMode ? ' cm-math-render-error-block' : ' cm-math-render-error-inline'}`;
    const heading = document.createElement(displayMode ? 'div' : 'span');
    heading.className = 'cm-math-render-error-heading';
    heading.textContent = displayMode ? diagnostic.title : 'Math error';
    card.appendChild(heading);

    const message = document.createElement(displayMode ? 'div' : 'span');
    message.className = 'cm-math-render-error-message';
    message.textContent = diagnostic.message;
    card.appendChild(message);

    if (displayMode && diagnostic.excerpt) {
        const excerpt = document.createElement('code');
        excerpt.className = 'cm-math-render-error-excerpt';
        excerpt.append(document.createTextNode(diagnostic.excerpt.before));
        const mark = document.createElement('mark');
        mark.textContent = diagnostic.excerpt.error;
        excerpt.append(mark, document.createTextNode(diagnostic.excerpt.after));
        card.appendChild(excerpt);
    }
    if (editable) {
        card.classList.add('cm-math-render-error-editable');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `${diagnostic.title}: ${diagnostic.message}. Edit math`);
        card.tabIndex = 0;
        if (displayMode) {
            const action = document.createElement('span');
            action.className = 'cm-math-render-error-action';
            action.textContent = 'Click to edit';
            card.appendChild(action);
        }
        if (onEdit) {
            card.addEventListener('keydown', event => {
                if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) onEdit(event);
            });
        }
    }
    if (!displayMode) card.title = `${diagnostic.title}: ${diagnostic.message}`;
    host.replaceChildren(card);
}
