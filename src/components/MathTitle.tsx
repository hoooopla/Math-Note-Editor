import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useStore } from '../store';

export function MathTitle({ text, className }: { text?: string | null; className?: string }) {
    const macros = useStore(state => state.settings?.macros) || {};

    if (!text) {
        return <span className={className}>Untitled</span>;
    }

    const segments: Array<{ type: 'text'; content: string } | { type: 'math'; html: string }> = [];
    const isEscaped = (position: number) => {
        let backslashes = 0;
        for (let index = position - 1; index >= 0 && text[index] === '\\'; index--) backslashes++;
        return backslashes % 2 === 1;
    };
    const pushText = (content: string) => {
        if (content) segments.push({ type: 'text', content: content.replace(/\\\$/g, '$') });
    };

    let current = 0;
    let cursor = 0;
    while (cursor < text.length) {
        let delimiterLength = 0;
        let close = -1;
        if (text[cursor] === '$' && !isEscaped(cursor)) {
            delimiterLength = 1;
            for (let index = cursor + 1; index < text.length; index++) {
                if (text[index] === '$' && !isEscaped(index)) {
                    close = index;
                    break;
                }
            }
        } else if (text.startsWith('\\[', cursor) && !isEscaped(cursor)) {
            delimiterLength = 2;
            for (let index = cursor + 2; index < text.length - 1; index++) {
                if (text.startsWith('\\]', index) && !isEscaped(index)) {
                    close = index;
                    break;
                }
            }
        }
        if (close === -1) {
            cursor++;
            continue;
        }

        pushText(text.slice(current, cursor));
        const mathContent = text.slice(cursor + delimiterLength, close).trim();
        if (!mathContent) {
            pushText(text.slice(cursor, close + delimiterLength));
            current = close + delimiterLength;
            cursor = current;
            continue;
        }

        try {
            const html = katex.renderToString(mathContent, {
                throwOnError: false,
                displayMode: false,
                strict: false,
                macros
            });
            segments.push({ type: 'math', html });
        } catch (e: any) {
            pushText(text.slice(cursor, close + delimiterLength));
        }
        current = close + delimiterLength;
        cursor = current;
    }

    if (current < text.length) {
        pushText(text.slice(current));
    }

    if (segments.length === 1 && segments[0].type === 'text') {
        return <span className={className}>{text}</span>;
    }

    return (
        <span className={className}>
            {segments.map((seg, i) => {
                if (seg.type === 'text') {
                    return <React.Fragment key={i}>{seg.content}</React.Fragment>;
                } else {
                    return <span key={i} className="cm-math-inline inline-flex items-center" dangerouslySetInnerHTML={{ __html: seg.html! }} />;
                }
            })}
        </span>
    );
}
