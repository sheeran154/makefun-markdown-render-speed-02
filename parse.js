// Fast drop-in for marked 18.1.3 (GFM, default options): parse(markdown)
// returns exactly the HTML marked.parse(markdown) returns.
//
// Written from scratch as an independent implementation of the CommonMark
// 0.31.2 + GFM 0.29 rules as marked renders them. Where marked departs from
// the spec, this follows marked. No dependency, no I/O, no clock, no state
// kept between calls: parse() is pure per call.
//
// Speed comes from dispatch: the block and inline loops look at the next
// character first and only try the rules that can match there, instead of
// running every rule's regex at every position. The grammar patterns
// themselves are the CommonMark/GFM ones any correct renderer needs.

/* ------------------------------------------------------------------ */
/* Small pattern builder: compose a regex from named parts. Parts are */
/* named §name§ so a part's own text can never collide with a name.    */
/* ------------------------------------------------------------------ */

/* A part spliced into a pattern loses its leading ^ caret, the way
 * marked's edit() does: a caret that opens a part is not an anchor
 * once the part sits inside a bigger pattern. */
const CARET_RE = /(^|[^[])\^/g;
function build(pattern, flags, parts) {
  let src = pattern;
  if (parts) {
    for (const name of Object.keys(parts)) {
      const p = parts[name];
      const pSrc = (typeof p === 'string' ? p : p.source).replace(CARET_RE, '$1');
      src = src.split('§' + name + '§').join(pSrc);
    }
  }
  return new RegExp(src, flags || '');
}

/* ------------------------------------------------------------------ */
/* Shared helper patterns.                                             */
/* ------------------------------------------------------------------ */

const R = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: (() => {
    const cache = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = cache[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
        cache[i] = re;
      }
      return re;
    };
  })(),
  hrRegex: (() => {
    const cache = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = cache[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
        cache[i] = re;
      }
      return re;
    };
  })(),
  fencesBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = cache[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`);
        cache[i] = re;
      }
      return re;
    };
  })(),
  headingBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = cache[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`);
        cache[i] = re;
      }
      return re;
    };
  })(),
  htmlBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = cache[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
        cache[i] = re;
      }
      return re;
    };
  })(),
  blockquoteBeginRegex: (() => {
    const cache = [];
    return (indent) => {
      const i = Math.max(0, Math.min(3, indent - 1));
      let re = cache[i];
      if (!re) {
        re = new RegExp(`^ {0,${i}}>`);
        cache[i] = re;
      }
      return re;
    };
  })(),
};

/* Block-level HTML tag names (types 6 and 7 of the HTML block rule). */
const TAG = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const COMMENT = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const BLOCK_ATTR = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
const BULLET = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HR_PAT = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
/* Non-capturing form, for composed patterns where the group numbering
 * matters (the setext rule reads its underline as group 2). */
const HR_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const BLOCK_CODE_START = '(?: {4}| {0,3}\\t)';
const FENCES_START = ' {0,3}(?:`{3,}|~{3,})';
const BLOCKQUOTE_START = ' {0,3}>';
const HEADING_START = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_START = ' {0,3}(?:</?(?:§tag§)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

/* ------------------------------------------------------------------ */
/* Block grammar (GFM).                                                */
/* ------------------------------------------------------------------ */

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  list: build('^(§bull§)([ \\t][^\\n]*?)?(?:\\n|$)', '', { bull: BULLET }),
  text: /^[^\n]+/,
};

/* Setext (lheading): the content may not itself start a block that can
 * interrupt a paragraph; the underline is = or - with trailing spaces/tabs. */
BLOCK.lheading = build(
  '^(?!§bull§ |§blockCode§|§fences§|§blockquote§|§heading§|§html§|§table§)'
  + '((?:.|\\n(?!\\s*?\\n|§bull§ |§fences§|§blockquote§|§heading§|§hr§|§html§|§table§))+?)'
  + '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)', '', {
  bull: BULLET,
  blockCode: BLOCK_CODE_START,
  fences: FENCES_START,
  blockquote: BLOCKQUOTE_START,
  heading: HEADING_START,
  hr: HR_NC,
  html: ' {0,3}<[^\\n>]+>\\n',
  table: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
});

/* Link reference definition. */
const BLOCK_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\\\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
BLOCK.def = build('^ {0,3}\\[(§label§)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(§title§))? *(?:\\n+|$)', '', {
  label: BLOCK_LABEL,
  title: '(?:' + DEF_TITLE + ')',
});

/* HTML block (types 1-7). */
BLOCK.html = build(
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
  comment: COMMENT,
  tag: TAG,
  attribute: BLOCK_ATTR,
});

/* GFM table. */
BLOCK.table = build(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|§hr§|§heading§|§blockquote§|§code§|§fences§|§list§|§html§).*(?:\\n|$))*)\\n*|$)', '', {
  hr: HR_PAT,
  heading: HEADING_START,
  blockquote: BLOCKQUOTE_START,
  code: BLOCK_CODE_START + '[^\\n]',
  fences: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  list: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
  html: build(HTML_START, '', { tag: TAG }).source,
});

/* Paragraph: a run of lines, stopping before any block that can interrupt.
 * In GFM a table can interrupt too. Setext headings never interrupt. */
const PARA_CORE = '^([^\\n]+(?:\\n(?!§hr§|§heading§|§lheading§|§blockquote§|§fences§|§list§|§html§|§table§|[ \\t]+\\n)[^\\n]+)*)';
const PARA_FENCES = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const PARA_HTML = build(HTML_START, '', { tag: TAG }).source;
function paraRegex(listPat, tableSrc) {
  let core = PARA_CORE.replace('|§lheading§', '');
  if (!tableSrc) core = core.replace('|§table§', '');
  return build(core, '', {
    hr: HR_PAT,
    heading: HEADING_START,
    blockquote: BLOCKQUOTE_START,
    fences: PARA_FENCES,
    list: listPat,
    html: PARA_HTML,
    table: tableSrc || '',
  });
}
BLOCK.paragraph = paraRegex(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', BLOCK.table.source);

/* The paragraph used inside a blockquote: a bare list marker (any number)
 * starts a sibling list there, so it must not be lazily continued. */
BLOCK.blockquoteParagraph = paraRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', '');

/* Blockquote: a run of marked lines, each either a paragraph line or any
 * other line; the paragraph part uses the blockquote paragraph above. */
BLOCK.blockquote = build('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(§paragraph§)|[^\\n]*)(?:\\n|$))+', '', {
  paragraph: BLOCK.blockquoteParagraph.source,
});

/* ------------------------------------------------------------------ */
/* Inline grammar (GFM).                                               */
/* ------------------------------------------------------------------ */

const INLINE_LABEL_BRACKETS = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const INLINE_LABEL = '(?:\\[(?:§brackets§|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LINK_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const BOUNDED_BLOCK_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const BOUNDED_INLINE_LABEL = '(?:[^\\[\\]\\\\`]*(?:\\[(?:§brackets§|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const EXT_EMAIL = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const PROTOCOL = '[hH][tT][tT][pP][sS]?|[fF][tT][pP]';

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

INLINE.link = build('^!?\\[(§label§)\\]\\([ \\t\\n]*(§href§)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(§title§))?[ \\t\\n]*\\)', '', {
  label: build(INLINE_LABEL, '', { brackets: INLINE_LABEL_BRACKETS }).source,
  href: LINK_HREF,
  title: LINK_TITLE,
});
INLINE.reflink = build('^!?\\[(§label§)\\]\\[(§ref§)\\]', '', {
  label: build(INLINE_LABEL, '', { brackets: INLINE_LABEL_BRACKETS }).source,
  ref: BLOCK_LABEL,
});
INLINE.nolink = build('^!?\\[(§ref§)\\](?:\\[\\])?', '', { ref: BLOCK_LABEL });
INLINE.reflinkSearch = build(
  '!?\\[(§blabel§)\\]\\[(§bref§)\\]|!?\\[(§bref§)\\](?:\\[\\])?(?!\\()', 'g', {
  blabel: build(BOUNDED_INLINE_LABEL, '', { brackets: INLINE_LABEL_BRACKETS }).source,
  bref: BOUNDED_BLOCK_LABEL,
});
INLINE.url = build(
  '^§emailProtocol§|^((?:§protocol§):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^§email§', '', {
  emailProtocol: '(?:mailto:' + EXT_EMAIL + '|xmpp:' + EXT_EMAIL + '(?:\\/[A-Za-z0-9@.]+)?)',
  protocol: PROTOCOL,
  email: '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])',
});

/* ------------------------------------------------------------------ */
/* Helpers.                                                            */
/* ------------------------------------------------------------------ */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeRepl = (ch) => ESCAPE_MAP[ch];

/* Escape HTML. With encode, & < > " ' are all encoded; without it, an &
 * that can start a character reference is left alone. */
function escapeHtml(html, encode) {
  if (encode) {
    return R.escapeTest.test(html) ? html.replace(R.escapeReplace, escapeRepl) : html;
  }
  return R.escapeTestNoEncode.test(html) ? html.replace(R.escapeReplaceNoEncode, escapeRepl) : html;
}

/* Numeric character references stand for the character they name. Zero,
 * out of range, or surrogate values become the replacement character.
 * A decoded & must not join its neighbours into a new reference, so every
 * & that is not already one is escaped here. */
function decodeNumericRefs(text) {
  if (!R.numericCharacterReference.test(text)) return text;
  return text.replace(R.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(row, count) {
  const fixed = row.replace(R.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = fixed.split(R.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  }
  return cells;
}

/* Remove trailing c's (or, with invert, trailing non-c's). */
function rtrim(str, c, invert) {
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

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && R.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str; // keep a single trailing blank line
  return lines.slice(0, end + 1).join('\n');
}

/* Normalize a link label: trim, collapse inner whitespace to one space,
 * and fold case (the upper/lower round-trip folds characters toLowerCase
 * alone misses, e.g. ẞ -> ß -> SS). */
function normalizeLabel(label) {
  return label.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/* Index of the closing bracket that balances the first opening one:
 * -1 when there is none and the string is balanced, -2 when opens outnumber
 * closes, otherwise the index of the bracket that drops the level below 0. */
function findClosingBracket(str, b) {
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

function newContext() {
  return {
    links: Object.create(null),
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    inlineQueue: [],
    closerStack: [],
  };
}

function closerIndex(cx, maskedSrc, delim) {
  const frame = cx.closerStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastEm[delim];
  }
  return scanClosers(maskedSrc).lastEm[delim];
}

function delCloserIndex(cx, maskedSrc) {
  const frame = cx.closerStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) {
    return frame.lastDel;
  }
  return scanClosers(maskedSrc).lastDel;
}

/* A fence's own indentation is removed from each of its lines, so a line
 * indented less than the fence loses whatever indentation it has. */
function indentCodeCompensation(raw, text) {
  const m = raw.match(R.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const inner = node.match(R.beginningSpace);
    if (inner === null) return node;
    return node.slice(Math.min(inner[0].length, indentToCode.length));
  }).join('\n');
}

/* A label that ends inside an inline tag or autolink is not a label end. */
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.tag.exec(tokenSrc) || INLINE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

/* Build a link or image token from a matched label, tokenizing the label
 * text as inline content. A link whose text already holds a link is not
 * a link at all (the caller falls through to text); an image may hold one. */
function outputLink(cx, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(R.outputLinkReplace, '$1');
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

function tokEscape(src) {
  const cap = INLINE.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tokTag(cx, src) {
  const cap = INLINE.tag.exec(src);
  if (cap) {
    if (!cx.state.inLink && R.startATag.test(cap[0])) cx.state.inLink = true;
    else if (cx.state.inLink && R.endATag.test(cap[0])) cx.state.inLink = false;
    if (!cx.state.inRawBlock && R.startPreScriptTag.test(cap[0])) cx.state.inRawBlock = true;
    else if (cx.state.inRawBlock && R.endPreScriptTag.test(cap[0])) cx.state.inRawBlock = false;
    return { type: 'html', raw: cap[0], inLink: cx.state.inLink, inRawBlock: cx.state.inRawBlock, block: false, text: cap[0] };
  }
}

function tokLink(cx, src) {
  if (cx.state.linkParenPossible === false) return undefined;
  const cap = INLINE.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
    const trimmedUrl = cap[2].trim();
    if (R.startAngleBracket.test(trimmedUrl)) {
      if (!R.endAngleBracket.test(trimmedUrl)) return undefined;
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
    } else {
      const lastParenIndex = findClosingBracket(cap[2], '()');
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
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
    let href = cap[2];
    let title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
    return outputLink(cx, cap, {
      href: href ? href.replace(INLINE.anyPunctuation, '$1') : href,
      title: title ? title.replace(INLINE.anyPunctuation, '$1') : title,
    }, cap[0]);
  }
}

function tokReflink(cx, src) {
  let cap = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return undefined;
    const link = cx.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(cx, cap, link, cap[0]);
  }
}

function tokEmStrong(cx, src, maskedSrc, prevChar = '') {
  let match = INLINE.emStrongLDelim.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punctuation.exec(prevChar);
  // _ can't be between two alphanumerics.
  if (match[4] && prevChar.match(R.unicodeAlphaNumeric)) return undefined;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const endReg = delimChar === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastPossible = closerIndex(cx, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
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
      const lastCharLength = [...match[0]][0].length;
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

function tokCodespan(src) {
  const cap = INLINE.code.exec(src);
  if (cap) {
    let text = cap[2].replace(R.newLineCharGlobal, ' ');
    const hasNonSpaceChars = R.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokBr(src) {
  const cap = INLINE.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function tokDel(cx, src, maskedSrc, prevChar = '') {
  let match = INLINE.delLDelim.exec(src);
  if (!match) return undefined;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = INLINE.delRDelim;
    const lastPossible = delCloserIndex(cx, maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: tokenizeInline(cx, text) };
    }
  }
  return undefined;
}

function tokAutolink(src) {
  const cap = INLINE.autolink.exec(src);
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

function tokUrl(src) {
  const cap = INLINE.url.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = INLINE.backpedal.exec(cap[0])?.[0] ?? '';
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
function tokInlineText(cx, src) {
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
  const cap = INLINE.text.exec(src);
  if (cap) {
    const escaped = cx.state.inRawBlock;
    return { type: 'text', raw: cap[0], text: escaped ? cap[0] : decodeNumericRefs(cap[0]), escaped };
  }
}

/* Does this link text hold a link already? An image does not count. */
function linkInText(cx, text) {
  if (!text.includes('[')) return false;
  const linkRule = INLINE.link;
  for (const match of text.matchAll(INLINE.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INLINE.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(cx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(cx, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

/* Mask links, code, html and escapes so emStrong and del do not see their
 * delimiters inside them. Every mask keeps the length it replaces. */
function maskSrc(cx, src) {
  let maskedSrc = src;
  if (cx.links && src.includes('[')) {
    const reflinkSearch = INLINE.reflinkSearch;
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
    maskedSrc = maskedSrc.replace(INLINE.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(INLINE.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

/* One paren scan per inline run, shared with tokLink: without a ')'
 * ahead the link regex cannot match, and skipping it avoids its
 * quadratic backtracking over unterminated-link inputs. */
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
  const maskedSrc = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(cx, src) : src;
  const frame = scanClosers(maskedSrc);
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
      token = tokEscape(src) || tokBr(src);
    } else if (ch === '<') {
      token = tokTag(cx, src) || tokAutolink(src);
    } else if (ch === '[' || (ch === '!' && src[1] === '[')) {
      token = tokLink(cx, src) || tokReflink(cx, src);
    } else if (ch === '*' || ch === '_') {
      token = tokEmStrong(cx, src, maskedSrc, prevChar);
      /* An email address may start with '_' (it is a local-part char).
       * If the '_' cannot open emphasis, the URL rule still has to run
       * before text — otherwise '_leading@example.com' loses its '_'. */
      if (!token && ch === '_' && !cx.state.inLink) token = tokUrl(src);
    } else if (ch === '`') {
      token = tokCodespan(src);
    } else if (ch === '~') {
      token = tokDel(cx, src, maskedSrc, prevChar);
    } else if (ch === ' ') {
      token = tokBr(src);
    } else if (!cx.state.inLink && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || hasAt)) {
      /* Any letter can open a scheme (the text rule only stops mid-run
       * before http/https/ftp/www/mailto/xmpp/email, but at a run start
       * any scheme may begin — e.g. Https:// with a capital H). */
      token = tokUrl(src);
    }
    if (!token) {
      token = tokInlineText(cx, src);
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

function tokSpace(src) {
  const cap = BLOCK.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function tokCode(src) {
  const cap = BLOCK.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(R.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function tokFences(src) {
  const cap = BLOCK.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function tokHeading(cx, src) {
  const cap = BLOCK.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (R.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || R.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(cx, text) };
  }
}

function tokHr(src) {
  const cap = BLOCK.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(cx, src) {
  const cap = BLOCK.blockquote.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (R.blockquoteStart.test(lines[i])) {
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
        .replace(R.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
        .replace(R.blockquoteSetextReplace, '\n    $1')
        .replace(R.blockquoteSetextReplace2, '');
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
        const newText = oldToken.raw + '\n' + continuation.replace(R.blockquoteSetextReplace2, '');
        const newToken = tokBlockquote(cx, newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokList(cx, newText);
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

function tokList(cx, src) {
  let cap = BLOCK.list.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;
    const list = { type: 'list', raw: '', ordered: isordered, start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = R.listItemRegex(bull);
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) break;
      if (BLOCK.hr.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const firstLine = cap[2].split('\n', 1)[0];
      const bulletIndent = cap[1].length;
      let line = firstLine.replace(R.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
      let nextLine = src.split('\n', 1)[0];
      let blankLine = !line.trim();
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(R.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && R.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const nextBulletRegex = R.nextBulletRegex(indent);
        const hrRegex = R.hrRegex(indent);
        const fencesBeginRegex = R.fencesBeginRegex(indent);
        const headingBeginRegex = R.headingBeginRegex(indent);
        const htmlBeginRegex = R.htmlBeginRegex(indent);
        const blockquoteBeginRegex = R.blockquoteBeginRegex(indent);
        while (src) {
          const nl = src.indexOf('\n');
          const rawLine = nl === -1 ? src : src.slice(0, nl);
          nextLine = rawLine;
          const nextLineWithoutTabs = nextLine.replace(R.leadingSpaceTab, (ws) => expandTabs(ws));
          // Dispatch on the first non-space character: only the block
          // starts that can begin with that character are tested, and
          // only when the marker sits within this item's indent. Most
          // lines are plain text, so no regex runs for them at all.
          const firstNs = nextLineWithoutTabs.search(R.nonSpaceChar);
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
          if (firstNs >= indent || !nextLine.trim()) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (line.replace(R.tabCharGlobal, '    ').search(R.nonSpaceChar) >= 4) break;
            // Same dispatch for the item's first line.
            const lineNs = line.search(R.nonSpaceChar);
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
              && BLOCK.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = !nextLine.trim();
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlankLine) list.loose = true;
        else if (R.doubleBlankLine.test(raw)) endsWithBlankLine = true;
      }
      list.items.push({ type: 'list_item', raw, task: !!R.listIsTask.test(itemContents), loose: false, text: itemContents, tokens: [] });
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
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => R.anyLine.test(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(R.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(R.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(R.listReplaceTask, '');
        for (let i = cx.inlineQueue.length - 1; i >= 0; i--) {
          if (R.listIsTask.test(cx.inlineQueue[i].src)) {
            cx.inlineQueue[i].src = cx.inlineQueue[i].src.replace(R.listReplaceTask, '');
            break;
          }
        }
        const taskRaw = R.listTaskCheckbox.exec(item.raw);
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

function tokHtml(src) {
  const cap = BLOCK.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
}

function tokDef(cx, src) {
  const cap = BLOCK.def.exec(src);
  if (cap) {
    if (!R.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(R.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(cx, src) {
  const cap = BLOCK.table.exec(src);
  if (!cap) return undefined;
  if (!R.tableDelimiter.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(R.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(R.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) return undefined;
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const align of aligns) {
    if (R.tableAlignRight.test(align)) item.align.push('right');
    else if (R.tableAlignCenter.test(align)) item.align.push('center');
    else if (R.tableAlignLeft.test(align)) item.align.push('left');
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
 * spaces, then '=' or '-'. Without one the rule cannot match, so this
 * cheap scan skips the backtracking setext regex on plain paragraphs. */
const SETEXT_UNDERLINE = /\n {0,3}[=-]/;
function tokLheading(cx, src) {
  if (!SETEXT_UNDERLINE.test(src)) return;
  const cap = BLOCK.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(cx, text) };
  }
}

function tokParagraph(cx, src) {
  const cap = BLOCK.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(cx, text) };
  }
}

function tokText(cx, src) {
  const cap = BLOCK.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(cx, cap[0]) };
  }
}

/* ------------------------------------------------------------------ */
/* Block loop. Rules are tried in marked's order; the first character */
/* decides which ones can match, so most attempts are skipped.         */
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
      token = tokSpace(src);
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
      token = tokCode(src);
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
      token = tokFences(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '#') {
      token = tokHeading(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '-' || first === '_' || first === '*') {
      token = tokHr(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      token = tokList(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '>') {
      token = tokBlockquote(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '+' || (first >= '0' && first <= '9')) {
      token = tokList(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '<') {
      token = tokHtml(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    if (first === '[') {
      token = tokDef(cx, src);
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
          if (!cx.links[token.tag]) cx.links[token.tag] = { href: token.href, title: token.title };
          tokens.push(token);
        }
        continue;
      }
    }
    if (tableMayFollow(src)) {
      token = tokTable(cx, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    token = tokLheading(cx, src);
    if (token) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    if (cx.state.top) {
      token = tokParagraph(cx, src);
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
    token = tokText(cx, src);
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
  src = src.replace(R.carriageReturn, '\n');
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
function renderPlain(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += t.tokens ? renderPlain(t.tokens) : t.text;
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

function renderInline(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape':
      case 'text': {
        out += ('tokens' in t && t.tokens) ? renderInline(t.tokens)
          : (('escaped' in t && t.escaped) ? t.text : escapeHtml(t.text));
        break;
      }
      case 'html':
        out += t.text;
        break;
      case 'link': {
        const parsedText = t.autolink ? escapeHtml(t.text, true) : renderInline(t.tokens);
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
        const text = t.tokens ? renderPlain(t.tokens) : t.text;
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
        out += `<strong>${renderInline(t.tokens)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderInline(t.tokens)}</em>`;
        break;
      case 'codespan':
        out += `<code>${escapeHtml(t.text, true)}</code>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += `<del>${renderInline(t.tokens)}</del>`;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderBlock(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${t.depth}>${renderInline(t.tokens)}</h${t.depth}>\n`;
        break;
      case 'code': {
        const langString = (t.lang || '').match(R.notSpaceStart)?.[0];
        const code = t.text ? t.text.replace(R.endingNewline, '') + '\n' : '';
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
        for (let j = 0; j < t.header.length; j++) cell += renderTableCell(t.header[j]);
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (let j = 0; j < t.rows.length; j++) {
          const row = t.rows[j];
          cell = '';
          for (let k = 0; k < row.length; k++) cell += renderTableCell(row[k]);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlock(t.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let body = '';
        for (const item of t.items) body += `<li>${renderBlock(item.tokens)}</li>\n`;
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
        out += `<p>${renderInline(t.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderInline(t.tokens);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(cell) {
  const content = renderInline(cell.tokens);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

/* ------------------------------------------------------------------ */
/* Entry point.                                                        */
/* ------------------------------------------------------------------ */

export function parse(markdown) {
  const cx = newContext();
  const tokens = lex(cx, markdown);
  return renderBlock(tokens);
}
