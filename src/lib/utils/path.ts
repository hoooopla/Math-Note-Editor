export function splitPath(path: string): string[] {
    const dollars: number[] = [];
    for (let index = 0; index < path.length; index++) {
        if (path[index] !== '$') continue;
        let backslashes = 0;
        for (let cursor = index - 1; cursor >= 0 && path[cursor] === '\\'; cursor--) backslashes++;
        if (backslashes % 2 === 0) dollars.push(index);
    }
    if (dollars.length % 2 === 1) dollars.pop();
    const pairedDollars = new Set(dollars);
    const result: string[] = [];
    let current = '';
    let inMath = false;
    for (let i = 0; i < path.length; i++) {
        const char = path[i];
        if (char === '$' && pairedDollars.has(i)) {
            inMath = !inMath;
            current += char;
        } else if (char === '/' && !inMath) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}
