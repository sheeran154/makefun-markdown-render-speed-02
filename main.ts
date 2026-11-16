// Driver for the markfast entry: reads the cases, renders each one alone
// with parse(), and writes the HTML strings out in the cases' order.
//
// The harness runs `node /bot/main.ts` (Node 22, type-stripping). Outside a
// container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and
// /output. Only Node builtins are used here.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
