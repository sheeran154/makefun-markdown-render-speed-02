# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/sheeran154/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/sheeran154/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

markfast is a dependency-free Markdown parser that renders byte-identical HTML to marked 18.1.3 with its default settings, but noticeably faster. It implements the CommonMark 0.31.2 and GFM 0.29 grammars from scratch: block structure (headings, setext headings, fenced and indented code, blockquotes, lists with task items, tables, HTML blocks, link reference definitions, thematic breaks) and inline structure (links, reference links, autolinks, extended autolinks, emphasis and strong emphasis, strikethrough, code spans, hard breaks, entities, backslash escapes and inline HTML). The entry point is `parse(markdown)`, which returns the same HTML string that `marked.parse` returns for the same input. Speed comes from first-character dispatch in the block and inline loops, a bounded setext pre-check, per-indent cached list patterns, a manual leading-whitespace scan inside list items, delimiter-run scanning by code point, and gating the link/code/html masking step so it only runs when a paragraph actually contains something that could hide a delimiter. No caching across calls, no tables of outputs, no clock or file reads — every call parses from scratch and the output is deterministic.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=nvhyrpj1&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
