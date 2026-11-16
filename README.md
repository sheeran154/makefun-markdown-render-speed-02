# markfast — a faster drop-in for marked 18.1.3

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/sheeran154/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/sheeran154/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, byte-identical drop-in for
[marked](https://github.com/markedjs/marked) 18.1.3 with default options
(GFM on, breaks off, pedantic off, async off). `parse(markdown)` returns
exactly the HTML `marked.parse(markdown)` returns — on every input,
including all 680 CommonMark 0.31.2 + GFM 0.29 spec examples — while
running about 1.3× faster than marked itself on the practice set.

Built for the make.fun bounty
["Make Markdown rendering faster" (markdown-render-speed-02)](https://make.fun/bounty/markdown-render-speed-02).

## Files

- `parse.js` — the renderer. A single dependency-free ES module exporting
  `parse(markdown)`. Written from scratch as an independent implementation
  of CommonMark 0.31.2 + GFM 0.29 as marked renders them; where marked
  departs from the spec, this follows marked. Pure per call: no caching
  across calls, no I/O, no clock, no network, no lookup tables of inputs.
- `main.ts` — the driver. Reads `$MAKEFUN_INPUT_DIR/cases.json`
  (falling back to `/input/cases.json`), renders every case with `parse()`,
  and writes `$MAKEFUN_OUTPUT_DIR/html.json` (falling back to `/output`).
  Erasable TypeScript only; runs on Node 22 with type stripping.

## How it gets faster

- **First-character dispatch.** Both the block loop and the inline loop
  look at the next character first and only try the rules that can match
  there, instead of running every rule's regex at every position.
- **A fast text scanner.** Plain-text runs are consumed with one cheap
  combined scan for the next inline starter or URL/email/hard-break
  trigger; the full GFM text rule only runs when such a trigger is
  actually present (with an email-aware check so `_` inside an address
  like `parsea_b@example.com` is never split).
- **Cheaper emphasis closing.** The last `*`/`_`/`~` closer in a run is
  found with `lastIndexOf` instead of a character-by-character scan.
- **Targeted pre-checks.** Setext headings are only attempted when an
  underline line (`=`/`-`) is present; tables are only attempted when a
  delimiter row can follow; list continuation lines are dispatched by
  their first non-space character so most lines need no regex at all.
- **Masking only when needed.** Code-span, escape and link-destination
  masking for emphasis runs only when the run actually contains a
  backtick, bracket, backslash or `<`.

## Correctness

Verified against the kit's practice set (720 cases: 680 spec examples +
40 generated README documents, ~2.86M characters):

- **720/720 byte-identical** to marked 18.1.3's output.
- **Deterministic**: two runs produce byte-identical `html.json`.
- **15,000 randomised differential cases** (random blocks and inline
  constructs, five seeds) all match marked exactly.

## Usage

```js
import { parse } from './parse.js';
console.log(parse('# Hello\n\nSome **bold** text.'));
// <h1>Hello</h1>
// <p>Some <strong>bold</strong> text.</p>
```

Or run the driver on a cases file:

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
