// Fast marked drop-in driver: reads every case from /input (or
// MAKEFUN_INPUT_DIR), renders each one alone with parse(), and writes the
// HTML strings, in order, to /output (or MAKEFUN_OUTPUT_DIR)/html.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases: Case[] = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
