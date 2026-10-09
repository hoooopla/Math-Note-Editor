# Bundled TikZ-cd renderer

`tikzjax.js` is the browser renderer distributed by the Obsidian TikZJax
project: https://github.com/artisticat1/obsidian-tikzjax/blob/main/tikzjax.js
(retrieved 2026-10-09). It embeds the TikZJax TeX/WebAssembly engine from
https://github.com/kisonecat/tikzjax and the `tikz-cd` package. The upstream
file is bundled unchanged. The relevant upstream license texts are included
here as `obsidian-tikzjax-LICENSE.md` and `tikzjax-LICENSE.md`.

This large file is loaded only for `tikzcd` display math. The PWA caches it
after first use, rather than including it in the initial precache.

`bakoma/fonts/` contains the 140 BaKoMa Computer Modern TrueType fonts from
the CTAN BaKoMa archive. Their license is in `bakoma/LICENSE.md`. A diagram
embeds only the fonts it actually uses into its SVG image, so text retains
its TeX appearance without depending on fonts installed on the reader's device.
Font files are fetched lazily and cached by the PWA after first use.
