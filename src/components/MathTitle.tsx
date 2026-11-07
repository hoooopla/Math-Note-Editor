import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useStore } from '../store';
import { effectiveMathMacros } from '../lib/math-render-settings';
import { splitMathTitle } from '../lib/note-display-core.mjs';

export function MathTitle({ text, className }: { text?: string | null; className?: string }) {
    const settings = useStore(state => state.settings);
    const macros = React.useMemo(() => effectiveMathMacros(settings), [settings.macros, settings.emptySetStyle]);

    if (!text) {
        return <span className={className}>Untitled</span>;
    }

    const segments = splitMathTitle(text);
    if (segments.length === 1 && segments[0].type === 'text') {
        return <span className={className}>{segments[0].content}</span>;
    }

    return (
        <span className={className}>
            {segments.map((seg, i) => {
                if (seg.type === 'text') {
                    return <React.Fragment key={i}>{seg.content}</React.Fragment>;
                } else {
                    try {
                        return <span key={i} className="cm-math-inline inline-flex items-center" dangerouslySetInnerHTML={{ __html: katex.renderToString(seg.content, { throwOnError: false, displayMode: false, strict: false, macros }) }} />;
                    } catch {
                        return <React.Fragment key={i}>{seg.content}</React.Fragment>;
                    }
                }
            })}
        </span>
    );
}
