// Fast drop-in for marked 18.1.3 (GFM, default options): parse(markdown)
// returns exactly the HTML marked.parse(markdown) returns.
//
// Independent implementation of the CommonMark 0.31.2 + GFM 0.29 rules
// as marked renders them. Where marked departs from the spec, this
// follows marked. No dependency, no I/O, no clock, no state kept between
// calls: parse() is pure per call.
//
// Speed notes (measured against the v1 build on the 720-case practice
// set): the block and inline loops dispatch on the next character and
// only try the rules that can match there; the setext pre-check walks
// lines only up to the first blank line instead of scanning the rest
// of the document; the list loop scans leading whitespace by hand
// instead of running a regex replace on every line; emphasis/del
// lengths are counted arithmetically instead of spreading strings;
// numeric-reference decoding is gated on a literal '&#' test; and
// the inline masking pass is skipped when the run holds no closer.

/* ------------------------------------------------------------------ */
/* Pattern builder: compose a regex from named parts. Parts are named */
/* §name§ so a part's own text can never collide with a name.          */
/* ------------------------------------------------------------------ */

/* A part spliced into a pattern loses its leading ^ caret, the way
 * marked's edit() does: a caret that opens a part is not an anchor
 * once the part sits inside a bigger pattern. */
const CARET = /(^|[^[])\^/g;
function compose(pattern, flags, parts) {
  let src = pattern;
  if (parts) {
    for (const name of Object.keys(parts)) {
      const p = parts[name];
      const pSrc = (typeof p === 'string' ? p : p.source).replace(CARET, '$1');
      src = src.split('§' + name + '§').join(pSrc);
    }
  }
  return new RegExp(src, flags || '');
}

/* ------------------------------------------------------------------ */
/* Shared helper patterns.                                             */
/* ------------------------------------------------------------------ */

const RX = {
  stripIndent: /^(?: {0,3}\t| {1,4})/gm,
  unescapeBrackets: /\\([\[\]])/g,
  fenceIndent: /^(\s+)(?:```)/,
  leadWs: /^\s+/,
  trailHash: /#$/,
  leadSpace: /^ /,
  trailSpace: / $/,
  trailSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  newlineG: /\n/g,
  carriageReturn: /\r\n?/g,
  notSpaceStart: /^\S+/,
  endingNewline: /\n$/,
  tabG: /\t/g,
  leadSpaceTab: /^[ \t]+/,
  wsRun: /\s+/g,
  blank: /^[ \t]*$/,
  allBlank: /^\s*$/,
  doubleBlank: /\n[ \t]*\n[ \t]*$/,
  quoteStart: /^ {0,3}>/,
  quoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  quoteStrip: /^ {0,3}>[ \t]?/gm,
  quoteWs: /^( {0,3}>)([ \t]+)/gm,
  listNest: /^ {1,4}(?=( {4})*[^ ])/g,
  taskItem: /^\[[ xX]\][ \t]+\S/,
  taskStrip: /^\[[ xX]\][ \t]+/,
  taskBox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  angleHref: /^<(.*)>$/,
  pipeOrColon: /[:|]/,
  tableTrim: /^\||\| *$/g,
  tableTrail: /\n[ \t]*$/,
  alignR: /^ *-+: *$/,
  alignC: /^ *:-+: *$/,
  alignL: /^ *:-+ *$/,
  openA: /^<a /i,
  closeA: /^<\/a>/i,
  openPre: /^<(pre|code|kbd|script)(\s|>)/i,
  closePre: /^<\/(pre|code|kbd|script)(\s|>)/i,
  openAngle: /^</,
  closeAngle: />$/,
  alphaNum: /[\p{L}\p{N}]/u,
  numRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escTest: /[&<>"']/,
  escReplace: /[&<>"']/g,
  escTestPlain: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escReplacePlain: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  pct25: /%25/g,
  pipeG: /\|/g,
  pipeSplit: / \|/,
  pipeEsc: /\\\|/g,
  crlf: /\r\n|\r/g,
  spaceOnly: /^ +$/gm,
  nonSpaceStart: /^\S*/,
  trailNl: /\n$/,
  itemRe: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBullRe: (() => {
    const slots = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = slots[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
        slots[i] = re;
      }
      return re;
    };
  })(),
  hrRe: (() => {
    const slots = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = slots[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
        slots[i] = re;
      }
      return re;
    };
  })(),
  fenceRe: (() => {
    const slots = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = slots[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`);
        slots[i] = re;
      }
      return re;
    };
  })(),
  headRe: (() => {
    const slots = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = slots[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`);
        slots[i] = re;
      }
      return re;
    };
  })(),
  htmlRe: (() => {
    const slots = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = slots[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}(?:</?(?:${HTML_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
        slots[i] = re;
      }
      return re;
    };
  })(),
  quoteRe: (() => {
    const slots = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = slots[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}>`);
        slots[i] = re;
      }
      return re;
    };
  })(),
};

/* Block-level HTML tag names (types 6 and 7 of the HTML block rule). */
const HTML_TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const COMMENT_PAT = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const ATTR_PAT = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
const BULLET_PAT = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
/* Non-capturing form, for composed patterns where the group numbering
 * matters (the setext rule reads its underline as group 2). */
const HR_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const INDENTED_CODE = '(?: {4}| {0,3}\\t)';
const FENCE_SRC = ' {0,3}(?:`{3,}|~{3,})';
const QUOTE_SRC = ' {0,3}>';
const HEAD_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_SRC = ' {0,3}(?:</?(?:§tag§)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

/* ------------------------------------------------------------------ */
/* Block grammar (GFM).                                                */
/* ------------------------------------------------------------------ */

const BLK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  list: compose('^(§bull§)([ \\t][^\\n]*?)?(?:\\n|$)', '', { bull: BULLET_PAT }),
  text: /^[^\n]+/,
};

/* Setext (lheading): the content may not itself start a block that can
 * interrupt a paragraph; the underline is = or - with trailing spaces/tabs. */
BLK.lheading = compose(
  '^(?!§bull§ |§blockCode§|§fences§|§blockquote§|§heading§|§html§|§table§)'
  + '((?:.|\\n(?!\\s*?\\n|§bull§ |§fences§|§blockquote§|§heading§|§hr§|§html§|§table§))+?)'
  + '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)', '', {
  bull: BULLET_PAT,
  blockCode: INDENTED_CODE,
  fences: FENCE_SRC,
  blockquote: QUOTE_SRC,
  heading: HEAD_SRC,
  hr: HR_NC,
  html: ' {0,3}<[^\\n>]+>\\n',
  table: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
});

/* Link reference definition. */
const LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\\\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
BLK.def = compose('^ {0,3}\\[(§label§)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(§title§))? *(?:\\n+|$)', '', {
  label: LABEL_SRC,
  title: '(?:' + TITLE_SRC + ')',
});

/* HTML block (types 1-7). */
BLK.html = compose(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|§comment§[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(§tag§)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:§attribute§)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) close
  + ')', 'i', {
  comment: COMMENT_PAT,
  tag: HTML_TAG,
  attribute: ATTR_PAT,
});

/* GFM table. */
BLK.table = compose(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|§hr§|§heading§|§blockquote§|§code§|§fences§|§list§|§html§).*(?:\\n|$))*)\\n*|$)', '', {
  hr: HR_SRC,
  heading: HEAD_SRC,
  blockquote: QUOTE_SRC,
  code: INDENTED_CODE + '[^\\n]',
  fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
  html: compose(HTML_SRC, '', { tag: HTML_TAG }).source,
});

/* Paragraph: a run of lines, stopping before any block that can interrupt.
 * In GFM a table can interrupt too. Setext headings never interrupt. */
const PARA_CORE = '^([^\\n]+(?:\\n(?!§hr§|§heading§|§lheading§|§blockquote§|§fences§|§list§|§html§|§table§|[ \\t]+\\n)[^\\n]+)*)';
const PARA_FENCE = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const PARA_HTML = compose(HTML_SRC, '', { tag: HTML_TAG }).source;
function paraPattern(listPat, tableSrc) {
  let core = PARA_CORE.replace('|§lheading§', '');
  if (!tableSrc) core = core.replace('|§table§', '');
  return compose(core, '', {
    hr: HR_SRC,
    heading: HEAD_SRC,
    blockquote: QUOTE_SRC,
    fences: PARA_FENCE,
    list: listPat,
    html: PARA_HTML,
    table: tableSrc || '',
  });
}
BLK.paragraph = paraPattern(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', BLK.table.source);

/* The paragraph used inside a blockquote: a bare list marker (any number)
 * starts a sibling list there, so it must not be lazily continued. */
BLK.quoteParagraph = paraPattern(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', '');

/* Blockquote: a run of marked lines, each either a paragraph line or any
 * other line; the paragraph part uses the blockquote paragraph above. */
BLK.blockquote = compose('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(§paragraph§)|[^\\n]*)(?:\\n|$))+', '', {
  paragraph: BLK.quoteParagraph.source,
});

/* ------------------------------------------------------------------ */
/* Inline grammar (GFM).                                               */
/* ------------------------------------------------------------------ */

const BRACKET_INNER = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LABEL_INNER = '(?:\\[(?:§brackets§|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const HREF_INNER = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const TITLE_INNER = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const REF_BOUNDED = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const LABEL_BOUNDED = '(?:[^\\[\\]\\\\`]*(?:\\[(?:§brackets§|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const EMAIL_EXT = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const SCHEME = '[hH][tT][tT][pP][sS]?|[fF][tT][pP]';

const INL = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  emOpenAst: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emCloseAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emCloseUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delOpen: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delClose: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  anyPunct: /\\([\p{P}\p{S}])/gu,
  anyPunctCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

INL.link = compose('^!?\\[(§label§)\\]\\([ \\t\\n]*(§href§)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(§title§))?[ \\t\\n]*\\)', '', {
  label: compose(LABEL_INNER, '', { brackets: BRACKET_INNER }).source,
  href: HREF_INNER,
  title: TITLE_INNER,
});
INL.reflink = compose('^!?\\[(§label§)\\]\\[(§ref§)\\]', '', {
  label: compose(LABEL_INNER, '', { brackets: BRACKET_INNER }).source,
  ref: LABEL_SRC,
});
INL.nolink = compose('^!?\\[(§ref§)\\](?:\\[\\])?', '', { ref: LABEL_SRC });
INL.reflinkSearch = compose(
  '!?\\[(§blabel§)\\]\\[(§bref§)\\]|!?\\[(§bref§)\\](?:\\[\\])?(?!\\()', 'g', {
  blabel: compose(LABEL_BOUNDED, '', { brackets: BRACKET_INNER }).source,
  bref: REF_BOUNDED,
});
INL.url = compose(
  '^§emailProtocol§|^((?:§protocol§):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^§email§', '', {
  emailProtocol: '(?:mailto:' + EMAIL_EXT + '|xmpp:' + EMAIL_EXT + '(?:\\/[A-Za-z0-9@.]+)?)',
  protocol: SCHEME,
  email: '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])',
});

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escSub = (ch) => ESC_MAP[ch];

/* Escape HTML. With encode, & < > " ' are all encoded; without it, an &
 * that can start a character reference is left alone. */
function escapeHtml(html, encode) {
  if (encode) {
    return RX.escTest.test(html) ? html.replace(RX.escReplace, escSub) : html;
  }
  return RX.escTestPlain.test(html) ? html.replace(RX.escReplacePlain, escSub) : html;
}

/* Numeric character references stand for the character they name. Zero,
 * out of range, or surrogate values become the replacement character.
 * A decoded & must not join its neighbours into a new reference, so every
 * & that is not already one is escaped here. The '&#' literal test is a
 * cheap gate: the reference regex never matches without it. */
function decodeNumericRefs(text) {
  if (!text.includes('&#') || !RX.numRef.test(text)) return text;
  return text.replace(RX.numRefOrAmp, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href);
    if (href.includes('%25')) href = href.replace(RX.pct25, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(row, count) {
  const fixed = row.replace(RX.pipeG, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = fixed.split(RX.pipeSplit);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(RX.pipeEsc, '|');
  }
  return cells;
}

/* Remove trailing c's (or, with invert, trailing non-c's). */
function rtrimStr(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimBlankTail(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && RX.blank.test(lines[end])) end--;
  if (lines.length - end <= 2) return str; // keep a single trailing blank line
  return lines.slice(0, end + 1).join('\n');
}

/* Normalize a link label: trim, collapse inner whitespace to one space,
 * and fold case (the upper/lower round-trip folds characters toLowerCase
 * alone misses, e.g. ẞ -> ß -> SS). */
function normalizeLabel(label) {
  return label.trim().replace(RX.wsRun, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/* Index of the closing bracket that balances the first opening one:
 * -1 when there is none and the string is balanced, -2 when opens outnumber
 * closes, otherwise the index of the bracket that drops the level below 0. */
function closingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/* Fast ASCII classification, exact for the single-character checks the
 * emphasis rules need. Non-ASCII falls back to the unicode regexes. */
const ASCII_PUNCT = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) ASCII_PUNCT[c] = 1;
for (let c = 33; c <= 47; c++) if (c !== 42) ASCII_PUNCT[c] = 1;
for (let c = 58; c <= 64; c++) ASCII_PUNCT[c] = 1;
for (let c = 91; c <= 96; c++) if (c !== 95) ASCII_PUNCT[c] = 1;
for (let c = 123; c <= 126; c++) ASCII_PUNCT[c] = 1;
function isPunctChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT[code] === 1;
  return INL.punctuation.test(ch);
}
function isAlphaNumChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
  return RX.alphaNum.test(ch);
}

/* Code-point length of a delimiter run plus at most one following char:
 * the run is ASCII, so only a trailing astral pair can add a unit.
 * A lone low surrogate is not a pair and counts as its own code point. */
function runCodePoints(s) {
  const n = s.length;
  if (n < 2) return n;
  const last = s.charCodeAt(n - 1);
  if (last < 0xDC00 || last > 0xDFFF) return n;
  const prev = s.charCodeAt(n - 2);
  return (prev >= 0xD800 && prev <= 0xDBFF) ? n - 1 : n;
}

/* ------------------------------------------------------------------ */
/* Closer hints: one scan of an inline run for the last emphasis,      */
/* strong and strikethrough closers, shared by every opener in the     */
/* pass so a run with no closer never pays for a regex scan.            */
/* ------------------------------------------------------------------ */

/* Last run of a delimiter whose preceding character is not whitespace.
 * lastIndexOf walks backwards in C, so this is far cheaper than scanning
 * the whole run character by character. A run at position 0 counts as
 * preceded by '\n' (whitespace) and is skipped, as in the scan. */
function lastRunStart(src, ch) {
  let idx = src.lastIndexOf(ch);
  while (idx > 0) {
    let start = idx;
    while (start > 0 && src[start - 1] === ch) start--;
    if (start > 0) {
      const prev = src[start - 1];
      if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') return start;
      idx = src.lastIndexOf(ch, start - 2);
    } else {
      return -1;
    }
  }
  return -1;
}

function scanClosers(src) {
  return {
    lastEm: { '*': lastRunStart(src, '*'), '_': lastRunStart(src, '_') },
    lastDel: lastRunStart(src, '~'),
  };
}

/* ------------------------------------------------------------------ */
/* Per-parse context: link definitions, lexer state, the deferred      */
/* inline queue, and the closer-hint stack for nested inline passes.   */
/* ------------------------------------------------------------------ */

function freshContext() {
  return {
    links: Object.create(null),
    hasLinks: false,
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    inlineQueue: [],
    closerStack: [],
    listRes: new Map(),
  };
}

function closerAt(cx, maskedSrc, delim) {
  const frame = cx.closerStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastEm[delim];
  }
  return scanClosers(maskedSrc).lastEm[delim];
}

function delCloserAt(cx, maskedSrc) {
  const frame = cx.closerStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastDel;
  }
  return scanClosers(maskedSrc).lastDel;
}

/* A fence's own indentation is removed from each of its lines, so a line
 * indented less than the fence loses whatever indentation it has. */
function fenceIndentFix(raw, text) {
  const m = raw.match(RX.fenceIndent);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const inner = node.match(RX.leadWs);
    if (inner === null) return node;
    return node.slice(Math.min(inner[0].length, indentToCode.length));
  }).join('\n');
}

/* A label that ends inside an inline tag or autolink is not a label end. */
function labelEndsInToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INL.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INL.tag.exec(tokenSrc) || INL.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

/* Build a link or image token from a matched label, tokenizing the label
 * text as inline content. A link whose text already holds a link is not
 * a link at all (the caller falls through to text); an image may hold one. */
function makeLink(cx, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(RX.unescapeBrackets, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = cx.state.inLink;
  const outerLinkEmitted = cx.state.linkEmitted;
  const outerInRawBlock = cx.state.inRawBlock;
  cx.state.inLink = true;
  cx.state.linkEmitted = false;
  const tokens = tokenizeInline(cx, text);
  const textHasLink = cx.state.linkEmitted;
  cx.state.linkEmitted = outerLinkEmitted;
  cx.state.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      cx.state.inRawBlock = outerInRawBlock;
      return undefined;
    }
    cx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

/* ------------------------- inline rules ------------------------- */

function inlineEscape(src) {
  const cap = INL.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}

function inlineTag(cx, src) {
  const cap = INL.tag.exec(src);
  if (cap) {
    if (!cx.state.inLink && RX.openA.test(cap[0])) cx.state.inLink = true;
    else if (cx.state.inLink && RX.closeA.test(cap[0])) cx.state.inLink = false;
    if (!cx.state.inRawBlock && RX.openPre.test(cap[0])) cx.state.inRawBlock = true;
    else if (cx.state.inRawBlock && RX.closePre.test(cap[0])) cx.state.inRawBlock = false;
    return { type: 'html', raw: cap[0], inLink: cx.state.inLink, inRawBlock: cx.state.inRawBlock, block: false, text: cap[0] };
  }
}

function inlineLink(cx, src) {
  if (cx.state.linkParenPossible === false) return undefined;
  const cap = INL.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelEndsInToken(src, cap[1], labelStart)) return undefined;
    const trimmedUrl = cap[2].trim();
    if (RX.openAngle.test(trimmedUrl)) {
      if (!RX.closeAngle.test(trimmedUrl)) return undefined;
      const rtrimSlash = rtrimStr(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
    } else {
      const lastParenIndex = closingBracket(cap[2], '()');
      if (lastParenIndex === -2) return undefined;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // The ')' that ends the match is the link closer only when it is not
    // escaped: `[foo](/url\)` has no closer.
    const unescaped = rtrimStr(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (RX.openAngle.test(href)) href = href.slice(1, -1);
    return makeLink(cx, cap, {
      href: href ? href.replace(INL.anyPunct, '$1') : href,
      title: title ? title.replace(INL.anyPunct, '$1') : title,
    }, cap[0]);
  }
}

function inlineReflink(cx, src) {
  let cap = INL.reflink.exec(src) || INL.nolink.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelEndsInToken(src, cap[1], labelStart)) return undefined;
    const link = cx.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return makeLink(cx, cap, link, cap[0]);
  }
}

/* The last code point ending at index end of str (a lone surrogate is
 * its own code point; a high+low pair is one astral code point). */
function lastCodePoint(str, end) {
  if (end <= 0) return '';
  const c = str.charCodeAt(end - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && end >= 2) {
    const p = str.charCodeAt(end - 2);
    if (p >= 0xD800 && p <= 0xDBFF) return str.slice(end - 2, end);
  }
  return str[end - 1];
}

function inlineEmStrong(cx, src, maskedSrc, prevChar = '') {
  let match = INL.emOpenAst.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = lastCodePoint(maskedSrc, runStart);
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctChar(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : isPunctChar(prevChar);
  // _ can't be between two alphanumerics.
  if (match[4] && isAlphaNumChar(prevChar)) return undefined;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = runCodePoints(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const endReg = delimChar === '*' ? INL.emCloseAst : INL.emCloseUnd;
    const lastPossible = closerAt(cx, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: tokenizeInline(cx, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: tokenizeInline(cx, text) };
    }
  }
  return undefined;
}

function inlineCodespan(src) {
  const cap = INL.code.exec(src);
  if (cap) {
    let text = cap[2].replace(RX.newlineG, ' ');
    const hasNonSpaceChars = RX.nonSpace.test(text);
    const hasSpaceCharsOnBothEnds = RX.leadSpace.test(text) && RX.trailSpace.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}

function inlineBr(src) {
  const cap = INL.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function inlineDel(cx, src, maskedSrc, prevChar = '') {
  let match = INL.delOpen.exec(src);
  if (!match) return undefined;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || isPunctChar(prevChar)) {
    const lLength = runCodePoints(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = INL.delClose;
    const lastPossible = delCloserAt(cx, maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: tokenizeInline(cx, text) };
    }
  }
  return undefined;
}

function inlineAutolink(src) {
  const cap = INL.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function inlineUrl(src) {
  const cap = INL.url.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = INL.backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

/* Next position where a text run must stop: a special inline starter,
 * or a URL / email / hard-break trigger. One cheap scan; a trigger
 * match only ever falls back to the full text rule (never a wrong fast
 * path). A special character at index 0 also falls back — the run then
 * starts with a literal special character whose own rule just failed.
 * '_', '.', '+' and '-' can sit inside an email local part, so when
 * the stop character is one of those, an '@' ahead is checked: if the
 * character lies inside a valid email address, the full rule runs. */
const TEXT_NEXT = /[`~\\<!\[*_]|@|https?|ftp|www\.|mailto:|xmpp:| {2,}\n/i;
const TEXT_SPECIAL0 = new Set(['`', '~', '\\', '<', '!', '[', '*', '_']);
const EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
const EMAIL_DOMAIN = /^[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
function inEmailLocalPart(src, pos) {
  const at = src.indexOf('@', pos);
  if (at === -1) return false;
  let start = at;
  while (start > 0 && EMAIL_LOCAL.test(src[start - 1])) start--;
  if (start > pos) return false;
  return EMAIL_DOMAIN.test(src.slice(at + 1));
}
function inlineText(cx, src) {
  const m = TEXT_NEXT.exec(src);
  if (!m) {
    const escaped = cx.state.inRawBlock;
    return { type: 'text', raw: src, text: escaped ? src : decodeNumericRefs(src), escaped };
  }
  if (m.index > 0 && TEXT_SPECIAL0.has(m[0][0])) {
    const ch0 = m[0][0];
    if ((ch0 === '_' || ch0 === '.' || ch0 === '+' || ch0 === '-') && inEmailLocalPart(src, m.index)) {
      /* inside an email address — the full rule stops at its start */
    } else {
      const raw = src.slice(0, m.index);
      const escaped = cx.state.inRawBlock;
      return { type: 'text', raw, text: escaped ? raw : decodeNumericRefs(raw), escaped };
    }
  }
  const cap = INL.text.exec(src);
  if (cap) {
    const escaped = cx.state.inRawBlock;
    return { type: 'text', raw: cap[0], text: escaped ? cap[0] : decodeNumericRefs(cap[0]), escaped };
  }
}

/* Does this link text hold a link already? An image does not count. */
function linkInText(cx, text) {
  if (!text.includes('[')) return false;
  const linkRule = INL.link;
  for (const match of text.matchAll(INL.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INL.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(cx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(cx, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

/* Mask links, code, html and escapes so emStrong and del do not see their
 * delimiters inside them. Every mask keeps the length it replaces.
 * Masking only matters when a closer exists: it never introduces a
 * delimiter, so a run whose raw text holds no closer needs no mask at
 * all, and the raw scan doubles as the frame. */
function maskSrc(cx, src) {
  let maskedSrc = src;
  if (cx.hasLinks && src.includes('[')) {
    const reflinkSearch = INL.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(cx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(cx, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  // The code/escape mask only matches backticks and backslashes; the
  // link-destination mask also matches code spans and HTML tags, so it
  // runs when any of '[', '`' or '<' is present. Skip each scan when
  // its trigger characters are absent — both are no-ops then.
  if (src.includes('`') || src.includes('\\')) {
    maskedSrc = maskedSrc.replace(INL.anyPunctCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(INL.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

/* One paren scan per inline run, shared with inlineLink: without a ')'
 * ahead the link regex cannot match, and skipping it avoids its
 * quadratic backtracking over unterminated-link inputs. */
const HAS_DELIM = /[*_~]/;
function tokenizeInline(cx, src, tokens = []) {
  const prev = cx.state.linkParenPossible;
  cx.state.linkParenPossible = prev && src.includes(')');
  try {
    return tokenizeInlineInner(cx, src, tokens);
  } finally {
    cx.state.linkParenPossible = prev;
  }
}

function tokenizeInlineInner(cx, src, tokens) {
  let maskedSrc = src;
  let frame;
  if (HAS_DELIM.test(src)) {
    const rawFrame = scanClosers(src);
    const hasCloser = rawFrame.lastEm['*'] !== -1 || rawFrame.lastEm['_'] !== -1 || rawFrame.lastDel !== -1;
    // Masking only hides delimiters inside links, code spans, HTML
    // tags and escapes — regions that all start with '[', '`', '<'
    // or '\'. A run with delimiters but none of those has nothing
    // to mask, so the raw frame stands and no regex runs at all.
    const hasRegion = src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\');
    if (hasCloser && hasRegion) {
      maskedSrc = maskSrc(cx, src);
      frame = maskedSrc === src ? rawFrame : scanClosers(maskedSrc);
    } else {
      frame = rawFrame;
    }
  } else {
    frame = { lastEm: { '*': -1, '_': -1 }, lastDel: -1 };
  }
  cx.closerStack.push({ maskedSrc, lastEm: frame.lastEm, lastDel: frame.lastDel });
  try {
    return tokenizeInlineLoop(cx, src, maskedSrc, tokens);
  } finally {
    cx.closerStack.pop();
  }
}

function tokenizeInlineLoop(cx, src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  const hasAt = src.includes('@');
  let srcLength = Infinity;
  while (src) {
    if (src.length >= srcLength) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    srcLength = src.length;
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    let token;
    let fromText = false;
    const ch = src[0];
    // Dispatch on the first character: only rules that can match here run.
    if (ch === '\\') {
      token = inlineEscape(src) || inlineBr(src);
    } else if (ch === '<') {
      token = inlineTag(cx, src) || inlineAutolink(src);
    } else if (ch === '[' || (ch === '!' && src[1] === '[')) {
      token = inlineLink(cx, src) || inlineReflink(cx, src);
    } else if (ch === '*' || ch === '_') {
      token = inlineEmStrong(cx, src, maskedSrc, prevChar);
      /* An email address may start with '_' (it is a local-part char).
       * If the '_' cannot open emphasis, the URL rule still has to run
       * before text — otherwise '_leading@example.com' loses its '_'. */
      if (!token && ch === '_' && !cx.state.inLink) token = inlineUrl(src);
    } else if (ch === '`') {
      token = inlineCodespan(src);
    } else if (ch === '~') {
      token = inlineDel(cx, src, maskedSrc, prevChar);
    } else if (ch === ' ') {
      token = inlineBr(src);
    } else if (!cx.state.inLink && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || hasAt)) {
      /* Any letter can open a scheme (the text rule only stops mid-run
       * before http/https/ftp/www/mailto/xmpp/email, but at a run start
       * any scheme may begin — e.g. Https:// with a capital H). */
      token = inlineUrl(src);
    }
    if (!token) {
      token = inlineText(cx, src);
      fromText = !!token;
    }
    if (!token) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    src = src.substring(token.raw.length);
    if (token.type === 'text') {
      // Only a token from the text rule tracks the previous character
      // (a reflink that found no label returns a text token but does not).
      if (fromText) {
        if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
        keepPrevChar = true;
      }
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Block tokenizers. Each returns a token or undefined. The lexer      */
/* queues inline runs instead of tokenizing them at once, because      */
/* link definitions anywhere in the document affect earlier blocks.    */
/* ------------------------------------------------------------------ */

function queueInline(cx, src) {
  const tokens = [];
  cx.inlineQueue.push({ src, tokens });
  return tokens;
}

function blockSpace(src) {
  const cap = BLK.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function blockCode(src) {
  const cap = BLK.code.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    const text = raw.replace(RX.stripIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function blockFences(src) {
  const cap = BLK.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = fenceIndentFix(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(INL.anyPunct, '$1') : cap[2],
      text,
    };
  }
}

function blockHeading(cx, src) {
  const cap = BLK.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (RX.trailHash.test(text)) {
      const trimmed = rtrimStr(text, '#');
      if (!trimmed || RX.trailSpaceTab.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: rtrimStr(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(cx, text) };
  }
}

function blockHr(src) {
  const cap = BLK.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrimStr(cap[0], '\n') };
}

function blockQuote(cx, src) {
  const cap = BLK.blockquote.exec(src);
  if (cap) {
    let lines = rtrimStr(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (RX.quoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(RX.quoteWs, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
        .replace(RX.quoteSetext, '\n    $1')
        .replace(RX.quoteStrip, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;
      const top = cx.state.top;
      cx.state.top = true;
      blockTokens(cx, currentText, tokens, true);
      cx.state.top = top;
      if (lines.length === 0) break;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
        break;
      } else if (lastToken?.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(RX.quoteStrip, '');
        const newToken = blockQuote(cx, newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && RX.quoteStart.test(lines[0])) continue;
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = blockList(cx, newText);
        tokens[tokens.length - 1] = newToken;
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
}

/* First non-space index of a line, or -1 when the line is all
 * whitespace. Tabs are expanded first when present (the regex
 * search this replaces sees the expanded line). */
function firstNonSpace(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length ? i : -1;
}

/* Is the line blank (only whitespace)? Cheaper than trim(), which
 * allocates a new string and scans the whole line. Matches trim()
 * exactly: ASCII whitespace is checked by hand, and any non-ASCII
 * character falls back to a regex test (a line of pure Unicode
 * whitespace is blank, just as trim() says). */
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) continue;
    if (c < 128) return false;
    return RX.allBlank.test(s);
  }
  return true;
}

/* Does the string end with two blank lines (a blank line, then
 * another, allowing trailing spaces/tabs)? A backward walk over
 * the tail is far cheaper than the regex, which scans for \n. */
function endsDoubleBlank(str) {
  let i = str.length - 1;
  while (i >= 0 && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i--;
  if (i < 0 || str.charCodeAt(i) !== 10) return false;
  i--;
  while (i >= 0 && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i--;
  return i >= 0 && str.charCodeAt(i) === 10;
}

function blockList(cx, src) {
  let cap = BLK.list.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;
    const list = { type: 'list', raw: '', ordered: isordered, start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = RX.itemRe(bull);
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) break;
      if (BLK.hr.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const nl0 = cap[2].indexOf('\n');
      const firstLine = nl0 === -1 ? cap[2] : cap[2].slice(0, nl0);
      const bulletIndent = cap[1].length;
      let line = firstLine.includes('\t')
        ? firstLine.replace(RX.leadSpaceTab, (ws) => expandTabs(ws, bulletIndent))
        : firstLine;
      const nl1 = src.indexOf('\n');
      let nextLine = nl1 === -1 ? src : src.slice(0, nl1);
      let blankLine = isBlankLine(line);
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = firstNonSpace(line);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && RX.blank.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        // The per-indent block-start regexes are compiled once per
        // parse and cached on the context (indent is a small integer,
        // so only a handful of sets ever exist).
        let listRes = cx.listRes.get(indent);
        if (!listRes) {
          listRes = {
            nextBullet: RX.nextBullRe(indent),
            hr: RX.hrRe(indent),
            fences: RX.fenceRe(indent),
            heading: RX.headRe(indent),
            html: RX.htmlRe(indent),
            quote: RX.quoteRe(indent),
          };
          cx.listRes.set(indent, listRes);
        }
        const nextBulletRegex = listRes.nextBullet;
        const hrRegex = listRes.hr;
        const fencesBeginRegex = listRes.fences;
        const headingBeginRegex = listRes.heading;
        const htmlBeginRegex = listRes.html;
        const blockquoteBeginRegex = listRes.quote;
        while (src) {
          const nl = src.indexOf('\n');
          const rawLine = nl === -1 ? src : src.slice(0, nl);
          nextLine = rawLine;
          // Inline the leading-whitespace scan (no helper call, no
          // object allocation per line): most lines have no tab, so
          // the regex replace + search is skipped for them entirely.
          let nextLineWithoutTabs = nextLine;
          let firstNs;
          let _p = 0;
          let _hasTab = false;
          while (_p < nextLine.length) {
            const _c = nextLine.charCodeAt(_p);
            if (_c === 32) _p++;
            else if (_c === 9) { _hasTab = true; _p++; }
            else break;
          }
          if (!_hasTab) {
            firstNs = _p < nextLine.length ? _p : -1;
          } else {
            nextLineWithoutTabs = nextLine.replace(RX.leadSpaceTab, (ws) => expandTabs(ws));
            firstNs = firstNonSpace(nextLineWithoutTabs);
          }
          // Dispatch on the first non-space character: only the block
          // starts that can begin with that character are tested, and
          // only when the marker sits within this item's indent. Most
          // lines are plain text, so no regex runs for them at all.
          if (firstNs !== -1 && firstNs <= indent) {
            const fc = nextLineWithoutTabs[firstNs];
            if (fc === '`' || fc === '~') { if (fencesBeginRegex.test(nextLine)) break; }
            else if (fc === '#') { if (headingBeginRegex.test(nextLine)) break; }
            else if (fc === '<') { if (htmlBeginRegex.test(nextLine)) break; }
            else if (fc === '>') { if (blockquoteBeginRegex.test(nextLine)) break; }
            else if (fc === '*') { if (nextBulletRegex.test(nextLine) || hrRegex.test(nextLine)) break; }
            else if (fc === '+') { if (nextBulletRegex.test(nextLine)) break; }
            else if (fc === '-') { if (nextBulletRegex.test(nextLine) || hrRegex.test(nextLine)) break; }
            else if (fc === '_') { if (hrRegex.test(nextLine)) break; }
            else if (fc >= '0' && fc <= '9') { if (nextBulletRegex.test(nextLine)) break; }
          }
          if (firstNs >= indent || isBlankLine(nextLine)) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            const flatLine = line.includes('\t') ? line.replace(RX.tabG, '    ') : line;
            if (firstNonSpace(flatLine) >= 4) break;
            // Same dispatch for the item's first line.
            const lineNs = firstNonSpace(line);
            if (lineNs !== -1) {
              const lc = line[lineNs];
              if (lc === '`' || lc === '~') { if (fencesBeginRegex.test(line)) break; }
              else if (lc === '#') { if (headingBeginRegex.test(line)) break; }
              else if (lc === '<') { if (htmlBeginRegex.test(line)) break; }
              else if (lc === '-' || lc === '*' || lc === '_') { if (hrRegex.test(line)) break; }
            }
            // A lazy continuation can look like a setext underline after
            // list indentation is removed. Keep it in the paragraph.
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && BLK.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = isBlankLine(nextLine);
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlankLine) list.loose = true;
        else if (endsDoubleBlank(raw)) endsWithBlankLine = true;
      }
      list.items.push({ type: 'list_item', raw, task: !!RX.taskItem.test(itemContents), loose: false, text: itemContents, tokens: [] });
    }
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return undefined;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();
    for (const item of list.items) {
      cx.state.top = false;
      item.tokens = blockTokens(cx, item.text, []);
      if (!list.loose) {
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => RX.anyLine.test(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(RX.taskStrip, '');
        itemToken.raw = itemToken.raw.replace(RX.taskStrip, '');
        itemToken.text = itemToken.text.replace(RX.taskStrip, '');
        for (let i = cx.inlineQueue.length - 1; i >= 0; i--) {
          if (RX.taskItem.test(cx.inlineQueue[i].src)) {
            cx.inlineQueue[i].src = cx.inlineQueue[i].src.replace(RX.taskStrip, '');
            break;
          }
        }
        const taskRaw = RX.taskBox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = { type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkboxToken);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkboxToken.raw, text: checkboxToken.raw, tokens: [checkboxToken] });
            }
          } else {
            item.tokens.unshift(checkboxToken);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') token.type = 'paragraph';
        }
      }
    }
    return list;
  }
}

function blockHtml(src) {
  const cap = BLK.html.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
}

function blockDef(cx, src) {
  const cap = BLK.def.exec(src);
  if (cap) {
    if (!RX.openAngle.test(cap[2]) && closingBracket(cap[2], '()') !== -1) return undefined;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(RX.angleHref, '$1').replace(INL.anyPunct, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INL.anyPunct, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrimStr(cap[0], '\n'), href, title };
  }
}

function blockTable(cx, src) {
  const cap = BLK.table.exec(src);
  if (!cap) return undefined;
  if (!RX.pipeOrColon.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(RX.tableTrim, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(RX.tableTrail, '').split('\n') : [];
  if (headers.length !== aligns.length) return undefined;
  const item = { type: 'table', raw: rtrimStr(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const align of aligns) {
    if (RX.alignR.test(align)) item.align.push('right');
    else if (RX.alignC.test(align)) item.align.push('center');
    else if (RX.alignL.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: queueInline(cx, headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell, tokens: queueInline(cx, cell), header: false, align: item.align[i],
    })));
  }
  return item;
}

/* A setext heading needs an underline line: newline, up to three
 * spaces, then '=' or '-'. The underline must sit inside the
 * paragraph, before its first blank line, so this walk only looks
 * that far — the full-document regex scan it replaces is the
 * single most expensive pre-check in the block loop. */
function setextAhead(src) {
  let pos = 0;
  const n = src.length;
  while (pos < n) {
    const nl = src.indexOf('\n', pos);
    if (nl === -1) return false;
    let j = pos;
    while (j < nl && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
    if (j === nl) return false; // blank line: the paragraph ends here
    let k = nl + 1;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(k + sp) === 32) sp++;
    const c = src.charCodeAt(k + sp);
    if (c === 61 || c === 45) return true; // '=' or '-'
    pos = nl + 1;
  }
  return false;
}
function blockSetext(cx, src) {
  if (!setextAhead(src)) return;
  const cap = BLK.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: rtrimStr(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(cx, text) };
  }
}

function blockParagraph(cx, src) {
  const cap = BLK.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(cx, text) };
  }
}

function blockText(cx, src) {
  const cap = BLK.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(cx, cap[0]) };
  }
}

/* ------------------------------------------------------------------ */
/* Block loop. Rules are tried in marked's order; the first character  */
/* decides which ones can match, so most attempts are skipped.          */
/* ------------------------------------------------------------------ */

const TABLE_DELIM_ROW = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?[ \t]*(?:\n|$)/;
function tableMayFollow(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  return TABLE_DELIM_ROW.test(src.slice(nl + 1));
}

function blockTokens(cx, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length >= srcLength) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    srcLength = src.length;
    let token;
    const ch = src[0];
    let sp = 0;
    while (sp < 3 && src.charCodeAt(sp) === 32) sp++;
    const first = src[sp];
    const indented = (sp === 3 && first === ' ') || first === '\t';

    if (ch === '\n' || ch === ' ' || ch === '\t') {
      token = blockSpace(src);
      if (token) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }
    }
    if (indented) {
      token = blockCode(src);
      if (token) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        // An indented code block cannot interrupt a paragraph.
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          cx.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    }
    if (first === '`' || first === '~') {
      token = blockFences(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '#') {
      token = blockHeading(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '-' || first === '_' || first === '*') {
      token = blockHr(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      token = blockList(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '>') {
      token = blockQuote(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '+' || (first >= '0' && first <= '9')) {
      token = blockList(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '<') {
      token = blockHtml(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '[') {
      token = blockDef(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          cx.inlineQueue.at(-1).src = lastToken.text;
        } else {
          // The first definition of a label wins; a later one still
          // consumes its text.
          if (!cx.links[token.tag]) { cx.links[token.tag] = { href: token.href, title: token.title }; cx.hasLinks = true; }
          tokens.push(token);
        }
        continue;
      }
    }
    if (tableMayFollow(src)) {
      token = blockTable(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    token = blockSetext(cx, src);
    if (token) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (cx.state.top) {
      token = blockParagraph(cx, src);
      if (token) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          cx.inlineQueue.pop();
          cx.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        src = src.substring(token.raw.length);
        continue;
      }
    }
    token = blockText(cx, src);
    if (token) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        cx.inlineQueue.pop();
        cx.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  cx.state.top = true;
  return tokens;
}

/* Lex the whole document into block tokens, then run the deferred
 * inline passes (link definitions are only complete now). An inline
 * <pre>, <code>, <kbd> or <script> left open ends with the block
 * holding it, so the raw-block state is reset before each run. */
function lex(cx, src) {
  src = src.replace(RX.carriageReturn, '\n');
  const tokens = blockTokens(cx, src, []);
  for (let i = 0; i < cx.inlineQueue.length; i++) {
    const next = cx.inlineQueue[i];
    cx.state.inRawBlock = false;
    tokenizeInline(cx, next.src, next.tokens);
  }
  cx.inlineQueue = [];
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Rendering.                                                          */
/* ------------------------------------------------------------------ */

/* Plain-text rendering (image alt text): tags are dropped, emphasis
 * and links keep only their text. */
function renderPlain(cx, tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += t.tokens ? renderPlain(cx, t.tokens) : t.text;
        break;
      case 'codespan': case 'html': case 'text': case 'escape':
        out += t.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += t.raw;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInline(cx, tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape':
      case 'text': {
        out += ('tokens' in t && t.tokens) ? renderInline(cx, t.tokens)
          : (('escaped' in t && t.escaped) ? t.text : escapeHtml(t.text));
        break;
      }
      case 'html':
        out += t.text;
        break;
      case 'link': {
        const parsedText = t.autolink ? escapeHtml(t.text, true) : renderInline(cx, t.tokens);
        const cleanHref = cleanUrl(t.href);
        if (cleanHref === null) {
          out += parsedText;
          break;
        }
        const href = escapeHtml(cleanHref, t.autolink);
        let s = '<a href="' + href + '"';
        if (t.title) s += ' title="' + escapeHtml(t.title) + '"';
        s += '>' + parsedText + '</a>';
        out += s;
        break;
      }
      case 'image': {
        const text = t.tokens ? renderPlain(cx, t.tokens) : t.text;
        const cleanHref = cleanUrl(t.href);
        if (cleanHref === null) {
          out += escapeHtml(text);
          break;
        }
        let s = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(text)}"`;
        if (t.title) s += ` title="${escapeHtml(t.title)}"`;
        s += '>';
        out += s;
        break;
      }
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += `<strong>${renderInline(cx, t.tokens)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderInline(cx, t.tokens)}</em>`;
        break;
      case 'codespan':
        out += `<code>${escapeHtml(t.text, true)}</code>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += `<del>${renderInline(cx, t.tokens)}</del>`;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderBlock(cx, tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${t.depth}>${renderInline(cx, t.tokens)}</h${t.depth}>\n`;
        break;
      case 'code': {
        const langString = (t.lang || '').match(RX.notSpaceStart)?.[0];
        const code = t.text ? t.text.replace(RX.endingNewline, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escapeHtml(langString) + '">'
            + escapeHtml(code, true) + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (let j = 0; j < t.header.length; j++) cell += renderTableCell(cx, t.header[j]);
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (let j = 0; j < t.rows.length; j++) {
          const row = t.rows[j];
          cell = '';
          for (let k = 0; k < row.length; k++) cell += renderTableCell(cx, row[k]);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlock(cx, t.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let body = '';
        for (const item of t.items) body += `<li>${renderBlock(cx, item.tokens)}</li>\n`;
        const type = t.ordered ? 'ol' : 'ul';
        const startAttr = (t.ordered && t.start !== 1) ? (' start="' + t.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += t.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(cx, t.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderInline(cx, t.tokens);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cx, cell) {
  const content = renderInline(cx, cell.tokens);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

/* ------------------------------------------------------------------ */
/* Entry point.                                                        */
/* ------------------------------------------------------------------ */

export function parse(markdown) {
  const cx = freshContext();
  const tokens = lex(cx, markdown);
  return renderBlock(cx, tokens);
}
