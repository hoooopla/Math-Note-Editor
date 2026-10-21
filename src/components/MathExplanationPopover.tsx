import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
import { CodeMirrorEditor } from './CodeMirrorEditor';

export interface OpenMathExplanation {
    target: HTMLElement;
    content: string;
    math: string;
}

let nextPopoverId = 0;
const openPopoverIds: number[] = [];

interface Props extends OpenMathExplanation {
    macros: Record<string, string>;
    parentLabel?: string;
    visitedLabels?: string[];
    onClose: (restoreFocus?: boolean) => void;
    onOpenTab: () => void;
}

export function MathExplanationPopover({ target, content, math, macros, parentLabel, visitedLabels, onClose, onOpenTab }: Props) {
    const cardRef = useRef<HTMLElement>(null);
    const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 620, ready: false });
    const [popoverId] = useState(() => ++nextPopoverId);

    useLayoutEffect(() => {
        openPopoverIds.push(popoverId);
        return () => {
            const index = openPopoverIds.indexOf(popoverId);
            if (index >= 0) openPopoverIds.splice(index, 1);
        };
    }, [popoverId]);

    useLayoutEffect(() => {
        // Make room below the selected symbol near the viewport edge. Display
        // explanations intentionally anchor to the symbol rather than the
        // bottom of the whole equation, even when that overlays later rows.
        if (window.innerHeight - target.getBoundingClientRect().bottom < 220) {
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
        const update = () => {
            const card = cardRef.current;
            if (!card || !target.isConnected) { if (!target.isConnected) onClose(); return; }
            const symbol = target.getBoundingClientRect();
            const width = card.offsetWidth;
            const margin = 12;
            const left = Math.max(margin, Math.min(window.innerWidth - width - margin,
                symbol.left + symbol.width / 2 - width / 2));
            const top = Math.max(margin, symbol.bottom + 8);
            const maxHeight = Math.max(80, Math.min(620, window.innerHeight - top - margin));
            setPosition(previous => previous.left === left && previous.top === top && previous.maxHeight === maxHeight && previous.ready
                ? previous : { left, top, maxHeight, ready: true });
        };
        update();
        const observer = new ResizeObserver(update);
        if (cardRef.current) observer.observe(cardRef.current);
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [target, content, onClose]);

    useLayoutEffect(() => {
        const outside = (event: PointerEvent) => {
            const path = event.composedPath();
            const targetRect = target.getBoundingClientRect();
            // KaTeX's multiline vlists can sit transparently above a marked
            // symbol. Treat the symbol's visible rectangle as part of the
            // target even when that layout layer owns the pointer event.
            const insideTargetRect = event.clientX >= targetRect.left && event.clientX <= targetRect.right &&
                event.clientY >= targetRect.top && event.clientY <= targetRect.bottom;
            if (path.includes(target) || insideTargetRect ||
                path.some(item => item instanceof Element && item.matches('.math-explanation-popover'))) return;
            onClose();
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || openPopoverIds.at(-1) !== popoverId) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            onClose(true);
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        return () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', escape, true);
        };
    }, [target, onClose, popoverId]);

    return createPortal(
        <section ref={cardRef} className="math-explanation-popover" data-explanation-popover="true"
            role="dialog" aria-label={`Explanation for ${math}`}
            style={{ left: position.left, top: position.top, maxHeight: position.maxHeight,
                zIndex: 10050 + popoverId, visibility: position.ready ? 'visible' : 'hidden' }}>
            <header className="math-explanation-header">
                <span>Explanation</span>
                <div>
                    <button type="button" onClick={onOpenTab} aria-label="Open explanation in tab" title="Open explanation in tab"><ExternalLink size={15} /></button>
                    <button type="button" onClick={() => onClose(true)} aria-label="Close explanation"><X size={15} /></button>
                </div>
            </header>
            <div className="math-explanation-body">
                <CodeMirrorEditor content={content} isReadOnly isFocused={false} macros={macros}
                    focusDirection={null} onBlur={() => undefined} parentLabel={parentLabel}
                    visitedLabels={visitedLabels || (parentLabel ? [parentLabel] : [])} />
            </div>
        </section>, document.body
    );
}
