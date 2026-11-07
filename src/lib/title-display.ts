/**
 * Standout embeds present a title-like heading even though the stored title is
 * also used as sentence-friendly inline text. Capitalize only a leading
 * lowercase letter. A title beginning with math, punctuation, whitespace, or a
 * number is deliberately left alone.
 */
import { standoutDisplayTitle as sharedStandoutDisplayTitle } from './note-display-core.mjs';

export function standoutDisplayTitle(title: string | null): string | null {
    return sharedStandoutDisplayTitle(title);
}
