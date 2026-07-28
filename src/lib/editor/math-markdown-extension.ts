export const mathMarkdownExtension = {
  defineNodes: [{ name: "InlineMath" }, { name: "BlockMath" }],
  parseInline: [{
    name: "InlineMath",
    before: "Escape", // Take precedence over markdown escape
    parse(cx: any, next: number, pos: number) {
      if (next === 36) { // $
        if (pos > 0 && cx.char(pos - 1) === 92) return -1;
        let end = -1;
        for (let i = pos + 1; i < cx.end; i++) {
          if (cx.char(i) === 36 && cx.char(i - 1) !== 92) {
            end = i;
            break;
          }
        }
        if (end !== -1) {
          return cx.addElement(cx.elt("InlineMath", pos, end + 1));
        }
      } else if (next === 92 && cx.char(pos + 1) === 91) { // \[
        let end = -1;
        for (let i = pos + 2; i < cx.end; i++) {
          if (cx.char(i) === 92 && cx.char(i + 1) === 93) {
            end = i + 1;
            break;
          }
        }
        if (end !== -1) {
          return cx.addElement(cx.elt("BlockMath", pos, end + 1));
        }
      }
      return -1;
    }
  }]
};
