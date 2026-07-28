const katex = require('katex');
const macros = {
  "\\R": "\\R\\times\\C^3"
};
try {
  katex.renderToString("\\R", { macros, throwOnError: false });
  console.log("Done");
} catch (e) {
  console.log("Error:", e.message);
}
