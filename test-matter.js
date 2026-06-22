const m = require('gray-matter'); 
const s = m.stringify('Hello', {id:1}); 
console.log(JSON.stringify(s)); 
console.log(JSON.stringify(m(s).content));
