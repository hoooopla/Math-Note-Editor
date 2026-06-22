const m = require('gray-matter'); 
console.log(JSON.stringify(m.stringify('Hello\n', {id:1})));
console.log(JSON.stringify(m.stringify('Hello\n\n', {id:1})));
