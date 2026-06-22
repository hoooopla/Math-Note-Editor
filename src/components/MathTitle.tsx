import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useStore } from '../store';

export function MathTitle({ text, className }: { text?: string | null; className?: string }) {
    const macros = useStore(state => state.settings?.macros) || {};

    if (!text) {
        return <span className={className}>Untitled</span>;
    }

    const segments = [];
    let current = 0;
    const mathRegex = /(\$\$?)([\s\S]*?)\1/g;
    let match;

    while ((match = mathRegex.exec(text)) !== null) {
        if (match.index > current) {
            segments.push({ type: 'text', content: text.slice(current, match.index) });
        }
        
        try {
            const html = katex.renderToString(match[2], {
                throwOnError: false,
                displayMode: false,
                strict: false,
                macros
            });
            segments.push({ type: 'math', html });
        } catch (e: any) {
            segments.push({ type: 'text', content: match[0] });
        }
        current = match.index + match[0].length;
    }

    if (current < text.length) {
        segments.push({ type: 'text', content: text.slice(current) });
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
