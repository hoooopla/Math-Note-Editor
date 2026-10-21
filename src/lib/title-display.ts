/**
 * Standout embeds present a title-like heading even though the stored title is
 * also used as sentence-friendly inline text. Capitalize only a leading
 * lowercase letter. A title beginning with math, punctuation, whitespace, or a
 * number is deliberately left alone.
 */
export function standoutDisplayTitle(title: string | null): string | null {
    if (!title) return title;
    const first = title.match(/^./u)?.[0];
    if (!first || !/^\p{Ll}$/u.test(first)) return title;
    return first.toUpperCase() + title.slice(first.length);
}
