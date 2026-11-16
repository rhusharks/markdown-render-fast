# markdown-render-fast

A fast, byte-identical drop-in replacement for [marked](https://github.com/markedjs/marked)
18.1.3's `marked.parse()` with its default options (GFM on, breaks off, pedantic off,
async off), built for the [make.fun markdown-render-speed-02](https://make.fun) bounty.

## What it is

`parse.js` exports `parse(markdown)`, which returns exactly the HTML that
marked 18.1.3 renders for any input — verified byte for byte against marked on the
competition's practice set (720 cases: every CommonMark 0.31.2 and GFM 0.29 spec
example plus 40 large generated documents).

It is a specialized fork of marked's lexer/parser/renderer (MIT licensed; the vendored
marked build it derives from lives in `vendor/marked/` with its LICENSE and NOTICE).
The regex rules are imported from the vendored marked, so every match decision is
identical to marked. On top of that it:

- renders blocks and inline runs directly into a string-parts array joined once,
  instead of building token objects and concatenating strings in the parser,
- memoizes `encodeURI` results for link/image hrefs,
- avoids redundant work in list-item tab expansion and closer scanning.

## Usage

```js
import { parse } from './parse.js';
const html = parse('# hello\n');
```

## The driver

`main.ts` is the competition harness entrypoint: it reads `$MAKEFUN_INPUT_DIR`
(default `/input`)/`cases.json`, renders each case with `parse`, and writes
`$MAKEFUN_OUTPUT_DIR` (default `/output`)/`html.json`.

## License

MIT — see [LICENSE](LICENSE). The vendored marked is MIT — see
[vendor/marked/LICENSE](vendor/marked/LICENSE) and [vendor/marked/NOTICE](vendor/marked/NOTICE).
