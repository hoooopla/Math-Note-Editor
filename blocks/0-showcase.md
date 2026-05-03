---
title: 0. Cortex Editor Showcase
label: 'showcase:main'
---
Welcome to the Cortex Editor!
This is a comprehensive test block that shows off all features.

# Math Rendering
We support inline math like $E = mc^2$ and block math:

$$
\int_{a}^{b} x^2 dx = \frac{b^3 - a^3}{3}
$$

Custom macros are also supported out of the box, like $\R$ and $\N$.

## Embedded Blocks
You can embed other blocks using the `[[label]]` syntax.

Try interacting with this closed embedded block (press Enter to open, or click the title if it's rendered as standalone):
[[showcase:embed_1]] and

And here is a block that is open by default. You can navigate into it using the down arrow key!
[[showcase:embed_2∨]]

## Standout Embeds
You can also make an embed "stand out" by prefixing with `@`. It's great for referencing sections:
[[@showcase:embed_1]]

## Aliasing
Embeds can have custom aliases:
[[showcase:embed_2 | This is a Custom Alias for Embed 2]]

## Markdown Rendering
The editor natively supports syntax highlighting and rendering of standard Markdown:

**Bold** and *Italic* text.
~~Strikethrough~~ is also supported.

- Bulleted list item 1
- Bulleted list item 2
  - Nested item

1. Numbered list
2. Another item

> Blockquotes are great for quotes.
> > Nested blockquotes work too!

```javascript
// A code block
function hello() {
  console.log("Hello World!");
}
```

***

## Navigation
Use up and down arrow keys to smoothly navigate between the root block and the embedded blocks!
