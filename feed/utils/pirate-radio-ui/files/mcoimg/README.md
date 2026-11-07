# MCOimg, MCO Advanced's decoder

The Messenger draws MCOimg images (MCO Advanced's one-packet images) with
MCO Advanced's own JavaScript, unchanged:

| File | What |
| --- | --- |
| `mcoimg-codec.global.js` | v1 and v2 (`im:`), and the PNG renderer the others use (`window.MCOImg`) |
| `mcoimg-v3-codec.global.js` | v3 (`im3:`) (`window.MCOImgV3`) |
| `mcoimg-browser.global.js` | text and binary payloads to PNG (`window.MCOImgBrowser`) |

From <https://github.com/HDDen/meshcore-open>, `docs/mcoimg-js/` at
`a3114a3a89474a393c5258e85b5236db7400fdf9` (2026-07-10). MIT: see `LICENSE`.

SHA-256:

```text
207fd9a61e07737da84105e095dd03451f7f6ccf4de2e719dda259bc3466b9c6  mcoimg-codec.global.js
7b80f006817b8fafd388a1afecfcbbe7d75cd22e7f6e18b85ddfc788cca47d3a  mcoimg-v3-codec.global.js
0700e1d68793be35d5ca48e17372091cee5aa9857c214cb077c9b8223e61c16e  mcoimg-browser.global.js
```

The first two match the repository's `SHA256SUMS`; `mcoimg-browser.global.js`
was changed after that file was last written (035dad44, "added rendering of
original images", 2026-07-08), so its sum is this one.

The page loads them only when a message holding an image is first shown.
They make no network requests and use no storage; the Workers in
`mcoimg-browser.global.js` are its encoder's, which the page doesn't use.
There is no JavaScript decoder for v4 (`im4:`) yet: those show as such.
