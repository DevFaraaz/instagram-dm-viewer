# instagram dm viewer

instagram gives you your data and no way to read it.

so i built the way to read it.

**[→ try it](https://devfaraaz.github.io/instagram-dm-viewer/)** · no install, no signup, nothing uploaded.

<p align="center">
  <a href="https://devfaraaz.github.io/instagram-dm-viewer/">
    <img src="docs/demo.gif" alt="instagram dm viewer demo" width="900"/>
  </a>
</p>

[![stars](https://img.shields.io/github/stars/DevFaraaz/instagram-dm-viewer?style=social)](https://github.com/DevFaraaz/instagram-dm-viewer/stargazers) [![mit](https://img.shields.io/badge/license-mit-blue.svg)](./LICENSE) [![vite](https://img.shields.io/badge/built%20with-vite-646cff.svg)](https://vitejs.dev/)

---

your data is yours. it should belong to you in a form you can actually use.

drop your instagram export `.zip(s)` onto the page and your dms render in the chat ui you already know. left-gray bubbles. right-blue bubbles. photos, voice notes, videos, reactions, per-thread search. all of it.

nothing leaves your browser. there is no backend. you can verify by opening devtools and watching the network tab — it goes silent.

works with multi-gigabyte exports. works with multi-part exports. works with both formats instagram ships (json and html — the viewer auto-detects per thread).

---

## run it locally

```
npm install
npm run dev
```

build it:

```
npm run build
```

## get your data from instagram

accounts center → your information and permissions → download your information. pick json or html, either works. wait 1–2 days for the email. download every part if it's split.

---

## under the hood

a few things i think are interesting.

**streaming zip read** via fflate's `AsyncUnzipInflate`. the raw zip buffer never has to live fully in memory; bytes flow through a worker. ui stays interactive while gigabytes decompress.

**variable-height virtual list.** measured-height cache + binary-search offset lookup. heights re-measure after each render pass and `scrollTop` is adjusted so growing items above the viewport don't cause visible jumps. 100k+ message threads scroll smooth.

**sidebar indexing without `JSON.parse`.** each thread file's first 256 kb gets decoded, title and first message get pulled with regex, then only that first ~few-hundred-byte message object gets `JSON.parse`'d. constant time per conversation regardless of how chatty the thread is. **973 conversations across a 4.4 gb export indexes in ~2 seconds.**

**two formats.** instagram ships some users json, some users html. the viewer detects per thread and dispatches to the right parser. all downstream code (sidebar, virtual list, media, search) sees one normalized message record either way.

**utf-8 mojibake fix.** instagram's json exports double-encode utf-8 as latin-1. emojis arrive as `Ã©`. one line: reinterpret each char code as a raw byte, decode the resulting buffer as utf-8. done.

---

## what's not done

decompressed bytes sit in the js heap. that's fine on desktop chrome with 16+ gb of ram for exports up to ~5 gb. mobile browsers (1–2 gb heap caps) or larger exports will oom.

the fix is moving media to on-demand reads from the source `File` via `Blob.slice` + per-entry inflate. keeps resident memory in the tens of megabytes regardless of export size. issue is open. happy to take a pr.

---

## privacy

zero network requests with your data. zero. the page works fully offline once loaded — drop the .zip, browse, close the tab. nothing persists, nothing transmits, nothing analyzes.

if you don't trust me, fork it. read the code (it's small). host it yourself. or use it once on an offline machine. it's all the same to me.

---

## license

mit. fork it. ship something better. tell me about it.

— [@DevFaraaz](https://github.com/DevFaraaz)
