// Entry driver: render every case in the input directory with parse()
// and write the resulting HTML strings, in order, to html.json in the
// output directory. Input/output paths come from the MAKEFUN_*
// environment variables when set, defaulting to /input and /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface InputCase {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const inputCases: InputCase[] = JSON.parse(
  readFileSync(join(inputDir, 'cases.json'), 'utf8'),
);

const rendered: string[] = [];
for (const inputCase of inputCases) {
  rendered.push(parse(inputCase.markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
