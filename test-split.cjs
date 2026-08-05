function splitPath(path) {
    const result = [];
    let current = '';
    let inMath = false;
    for (let i = 0; i < path.length; i++) {
        const char = path[i];
        if (char === '$') {
            inMath = !inMath;
            current += char;
        } else if ((char === '/' || char === ':') && !inMath) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}
console.log(splitPath("Math/Fractions/$1/2$"));
console.log(splitPath("showcase:embed-2/child"));
