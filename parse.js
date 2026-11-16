// markfast v3 — a fast, dependency-free CommonMark / GFM renderer.
//
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its defaults (gfm on, breaks off, pedantic off, async off).
//
// Design: a block scanner records compact block nodes, then a renderer walks
// them; inline rendering is a direct single-pass scanner that emits HTML
// without building inline tokens. Nothing is cached across parse() calls;
// parse is pure per call.

export function parse(src) {
  return renderDoc(src);
}

// ---------------------------------------------------------------------------
// Grammar: the block and inline patterns, and the small shared patterns.
// They encode the CommonMark 0.31.2 / GFM 0.29 rules exactly as marked does;
// the layout and names here are my own.

const TAG_LIST =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// --- small shared patterns -------------------------------------------------
const R = {
  codeIndent: /^(?: {0,3}\t| {1,4})/gm,
  linkBracketEscape: /\\([\[\]])/g,
  fenceIndent: /^(\s+)(?:```)/,
  leadSpace: /^\s+/,
  hashEnd: /#$/,
  spaceStart: /^ /,
  spaceEnd: / $/,
  spaceTabEnd: /[ \t]$/,
  nonSpace: /[^ ]/,
  nlGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadSpaceTab: /^[ \t]+/,
  spaceRun: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlank: /\n[ \t]*\n[ \t]*$/,
  bqStart: /^ {0,3}>/,
  bqSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  bqSetext2: /^ {0,3}>[ \t]?/gm,
  bqMarkSpace: /^( {0,3}>)([ \t]+)/gm,
  listNest: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listTaskStrip: /^\[[ xX]\][ \t]+/,
  listTaskBox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefAngles: /^<(.*)>$/,
  tableDelim: /[:|]/,
  tableAlignTrim: /^\||\| *$/g,
  tableRowBlank: /\n[ \t]*$/,
  alignRight: /^ *-+: *$/,
  alignCenter: /^ *:-+: *$/,
  alignLeft: /^ *:-+ *$/,
  aTagOpen: /^<a /i,
  aTagClose: /^<\/a>/i,
  preTagOpen: /^<(pre|code|kbd|script)(\s|>)/i,
  preTagClose: /^<\/(pre|code|kbd|script)(\s|>)/i,
  angleOpen: /^</,
  angleClose: />$/,
  alphaNum: /[\p{L}\p{N}]/u,
  numRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numRefOrAmp:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escTest: /[&<>\"']/,
  escReplace: /[&<>\"']/g,
  escTestRaw: /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escReplaceRaw: /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  pct25: /%25/g,
  pipeFind: /\|/g,
  pipeSplit: / \|/,
  pipeEsc: /\\\|/g,
  crlf: /\r\n|\r/g,
  spaceOnlyLine: /^ +$/gm,
  nonSpaceStart: /^\S*/,
  nlEnd: /\n$/,
  punctClass: /[\p{P}\p{S}]/u,
  punctSpaceClass: /[\s\p{P}\p{S}]/u,
  nonPunctSpaceClass: /[^\s\p{P}\p{S}]/u,
  openQuoteClass: /[\p{Pi}\p{Ps}"']/u,
};

// A tiny "edit a pattern source" helper: build a composite pattern by
// replacing placeholder words in a source string, then compile it. A leading
// ^ in a replacement is dropped (it only ever anchored the pattern it came
// from); an escaped \^ or a [^ class is left alone.
const CARET_STRIP = /(^|[^\[])\^/g;
function buildRx(source, flags, subs) {
  let s = typeof source === 'string' ? source : source.source;
  if (subs) {
    for (const key of Object.keys(subs)) {
      const val = subs[key];
      const rep = (typeof val === 'string' ? val : val.source).replace(
        CARET_STRIP,
        '$1'
      );
      s = s.split(key).join(rep);
    }
  }
  return new RegExp(s, flags);
}

// --- block grammar ---------------------------------------------------------
// The paragraph body: lines that do not start a new block construct.
const PARA_BODY =
  '^([^\\n]+(?:\\n(?!HR|HEADING|LHEADING|BLOCKQUOTE|FENCES|LIST|HTML|TABLE|[ \\t]+\\n)[^\\n]+)*)';

const HR_FRAG =
  ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[\\t ]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_FRAG = ' {0,3}#{1,6}(?:\\s|$)';
const BQ_FRAG = ' {0,3}>';
const FENCES_FRAG =
  ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_FRAG =
  ' {0,3}(?:</?(?:TAGLIST)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// The paragraph body is shared by the normal, list-item and GFM variants.
// The |LHEADING / |TABLE placeholders carry their leading pipe, so removing
// them (normal / list-item) leaves no empty alternative behind.
function paragraphRx(listPat, tablePat) {
  return buildRx(PARA_BODY, '', {
    HR: HR_FRAG,
    HEADING: HEADING_FRAG,
    '|LHEADING': '',
    BLOCKQUOTE: BQ_FRAG,
    FENCES: FENCES_FRAG,
    LIST: listPat,
    HTML: HTML_FRAG,
    '|TABLE': tablePat ? '|' + tablePat : '',
    TAGLIST: TAG_LIST,
  });
}

// Table: header line, delimiter row, then body rows.
const TABLE_RX = buildRx(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|HR|HEADING|BLOCKQUOTE|CODE|FENCES|LIST|HTML).*(?:\\n|$))*)\\n*|$)",
  '',
  {
    HR: HR_FRAG,
    HEADING: HEADING_FRAG,
    BLOCKQUOTE: BQ_FRAG,
    CODE: '(?: {4}| {0,3}\\t)[^\\n]',
    FENCES: FENCES_FRAG,
    LIST: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
    HTML: HTML_FRAG,
    TAGLIST: TAG_LIST,
  }
);

// list-item paragraph: only a "1." / "1)" ordered marker interrupts it.
const PARA_LISTITEM = paragraphRx(
  ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
  ''
);
// GFM paragraph: a table delimiter row also interrupts it.
const PARA_GFM = paragraphRx(
  ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
  TABLE_RX.source
);

// list-item paragraph (Ke): any ordered bullet, and a bare bullet at EOL
// still interrupts a blockquote's paragraph continuation.
const PARA_BQ = paragraphRx(
  ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)',
  ''
);

// blockquote: lines starting with ">", or paragraph continuation lines.
const BQ_RX = buildRx(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(PARA)|[^\\n]*)(?:\\n|$))+',
  '',
  { PARA: PARA_BQ.source }
);

// HTML block, comment, and attribute fragments.
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_ATTR =
  / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const HTML_BLOCK_RX = buildRx(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|COMMENT[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(TAG)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))",
  'i',
  { COMMENT: HTML_COMMENT, TAG: TAG_LIST, ATTR: HTML_ATTR }
);

// Link reference definition: [label]: <href> "title"
const LABEL_INNER =
  '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_RX = buildRx(
  '^ {0,3}\\[(LABEL)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(TITLE))? *(?:\\n+|$)',
  '',
  {
    LABEL: LABEL_INNER,
    TITLE:
      '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))',
  }
);

const B = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  blockquote: BQ_RX,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  listBull: / {0,3}(?:[*+-]|\d{1,9}[.)])/,
  text: /^[^\n]+/,
  paragraph: PARA_GFM,
  paragraphList: PARA_LISTITEM,
  table: TABLE_RX,
  html: HTML_BLOCK_RX,
  def: DEF_RX,
  // setext heading: the body may not start a fence, blockquote, heading,
  // hr, html block, table, indented code or list item, and may not contain
  // a blank line. The GFM variant also lets a table delimiter row interrupt.
  lheading: buildRx(
    '^(?!BULL |BLOCKCODE|FENCES|BLOCKQUOTE|HEADING|HTML|TABLE)((?:.|\\n(?!\\s*?\\n|BULL |FENCES|BLOCKQUOTE|HEADING|HR|HTML|TABLE))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)',
    '',
    {
      BULL: ' {0,3}(?:[*+-]|\\d{1,9}[.)])',
      BLOCKCODE: '(?: {4}| {0,3}\\t)',
      FENCES: ' {0,3}(?:`{3,}|~{3,})',
      BLOCKQUOTE: BQ_FRAG,
      HEADING: HEADING_FRAG,
      HR: HR_FRAG,
      HTML: ' {0,3}<[^\\n>]+>\\n',
      TABLE: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
    }
  ),
};

// Per-indent helpers. These mirror the baseline's D() helper exactly: the
// cache is keyed by t-1 clamped to 0..3, and the regex is BUILT from that
// clamped value too — so an indent of 2 gets a "^ {0,1}" pattern, not
// "^ {0,2}". A nested bullet at the full indent does NOT end the item.
function cachedRx(maker) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = maker(n));
  };
}
// The item regex is built once per list from its bullet pattern.
function itemRx(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
}
const nextBullRx = cachedRx(
  (n) =>
    new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)
);
const hrAtRx = cachedRx(
  (n) =>
    new RegExp(
      `^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`
    )
);
const fenceAtRx = cachedRx(
  (n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)
);
const headingAtRx = cachedRx(
  (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)
);
const htmlAtRx = cachedRx(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i'
    )
);
const bqAtRx = cachedRx((n) => new RegExp(`^ {0,${n}}>`));

// --- inline grammar (GFM) --------------------------------------------------
// Punctuation character classes used by the emphasis delimiters.
const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_NT = '(?!~)[\\p{P}\\p{S}]';
const PUNCTSPACE = '[\\s\\p{P}\\p{S}]';
const PUNCTSPACE_NT = '(?!~)[\\s\\p{P}\\p{S}]';
const NONPUNCTSPACE = '[^\\s\\p{P}\\p{S}]';
const NONPUNCTSPACE_T = '(?:[^\\s\\p{P}\\p{S}]|~)';

// A label like [foo] that may hold nested brackets, escapes and code spans.
const BRACKET_PAIR = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LABEL_RX = buildRx(
  '(?:\\[(?:BRACKETS|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?',
  '',
  { BRACKETS: BRACKET_PAIR }
);
// A reference label: any run of non-bracket text, up to 999 chars.
const REF_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const REF_LABEL_999 = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
// A label as reflinkSearch sees it (bounded, for the masking pass).
const LABEL_SEARCH = buildRx(
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:BRACKETS|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?',
  '',
  { BRACKETS: BRACKET_PAIR }
);

const EMAIL_RX =
  '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_AT_RX =
  '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const PROTO_RX = '[hH][tT][tT][pP][sS]?|[fF][tT][pP]';
const MAILTO_RX = buildRx('(?:mailto:EMAIL|xmpp:EMAIL(?:\\/[A-Za-z0-9@.]+)?)', '', {
  EMAIL: EMAIL_RX,
});

// autolink: <scheme:...> or <email>
const AUTOLINK_RX = buildRx(
  '^<(SCHEME:[^\\s\\x00-\\x1f<>]*|EMAIL)>',
  '',
  {
    SCHEME: '[a-zA-Z][a-zA-Z0-9+.-]{1,31}',
    EMAIL:
      "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])",
  }
);

// inline tag: comment, closing tag, open tag, processing instruction,
// declaration, or CDATA section. Note the attribute separator here is \s
// (a tag attribute may start on the next line); the block-html attribute
// below uses spaces only.
const TAG_ATTR =
  /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;
const TAG_RX = buildRx(
  '^COMMENT|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:ATTR)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  '',
  {
    COMMENT: /<!--(?:-?>|[\s\S]*?-->)/,
    ATTR: TAG_ATTR,
  }
);

// inline link: [text](href "title")
const LINK_RX = buildRx(
  '^!?\\[(LABEL)\\]\\([ \\t\\n]*(HREF)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(TITLE))?[ \\t\\n]*\\)',
  '',
  {
    LABEL: LABEL_RX,
    HREF: '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))',
    TITLE:
      '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)',
  }
);
const REFLINK_RX = buildRx('^!?\\[(LABEL)\\]\\[(REF)\\]', '', {
  LABEL: LABEL_RX,
  REF: REF_LABEL,
});
const NOLINK_RX = buildRx('^!?\\[(REF)\\](?:\\[\\])?', '', { REF: REF_LABEL });

// reflink search (global, for the emphasis masking pass).
const REFLINK_SEARCH_RX = buildRx('REFLINK|NOLINK(?!\\()', 'g', {
  REFLINK: buildRx('^!?\\[(LABEL)\\]\\[(REF)\\]', '', {
    LABEL: LABEL_SEARCH,
    REF: REF_LABEL_999,
  }),
  NOLINK: buildRx('^!?\\[(REF)\\](?:\\[\\])?', '', { REF: REF_LABEL_999 }),
});

// extended autolink (bare URL / email in text).
const URL_RX = buildRx(
  '^MAILPROTO|^((?:PROTO):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^EMAIL',
  '',
  {
    MAILPROTO: MAILTO_RX,
    PROTO: PROTO_RX,
    EMAIL: EMAIL_AT_RX,
  }
);

// emphasis delimiters.
const EM_L_BASE =
  '^(?:\\*+(?:((?!\\*)PUNCT)|([^\\s*]))?)|^_+(?:((?!_)PUNCT)|([^\\s_]))?';
const EM_L_RX = buildRx(EM_L_BASE, 'u', { PUNCT: PUNCT_NT });

const EM_RA_BASE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)PUNCT(\\*+)(?=[\\s]|$)|NONPS(\\*+)(?!\\*)(?=PS|$)|(?!\\*)PS(\\*+)(?=NONPS)|[\\s](\\*+)(?!\\*)(?=PUNCT)|(?!\\*)PUNCT(\\*+)(?!\\*)(?=PUNCT)|NONPS(\\*+)(?=NONPS)';
const EM_RA_RX = buildRx(EM_RA_BASE, 'gu', {
  NONPS: NONPUNCTSPACE_T,
  PS: PUNCTSPACE_NT,
  PUNCT: PUNCT_NT,
});
const EM_RU_BASE =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)PUNCT(_+)(?=[\\s]|$)|NONPS(_+)(?!_)(?=PS|$)|(?!_)PS(_+)(?=NONPS)|[\\s](_+)(?!_)(?=PUNCT)|(?!_)PUNCT(_+)(?!_)(?=PUNCT)';
const EM_RU_RX = buildRx(EM_RU_BASE, 'gu', {
  NONPS: NONPUNCTSPACE,
  PS: PUNCTSPACE,
  PUNCT: PUNCT,
});

// strikethrough delimiters.
const DEL_L_RX = buildRx('^~~?(?:((?!~)PUNCT)|[^\\s~])', 'u', {
  PUNCT: PUNCT,
});
const DEL_R_BASE =
  '^[^~]+(?=[^~])|(?!~)PUNCT(~~?)(?=[\\s]|$)|NONPS(~~?)(?!~)(?=PS|$)|(?!~)PS(~~?)(?=NONPS)|[\\s](~~?)(?!~)(?=PUNCT)|(?!~)PUNCT(~~?)(?!~)(?=PUNCT)|NONPS(~~?)(?=NONPS)';
const DEL_R_RX = buildRx(DEL_R_BASE, 'gu', {
  NONPS: NONPUNCTSPACE,
  PS: PUNCTSPACE,
  PUNCT: PUNCT,
});

// plain-text run: stops before the next inline construct, hard break,
// bare URL, or email address.
const EMAIL_CHARS = "a-zA-Z0-9.!#$%&'*+\\/=?_`{|}~-";
const TEXT_RX = buildRx(
  '^(?:[^a-zA-Z0-9](?=MAILPROTO)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[EMAILCHARS]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|PROTO:\\/\\/|WWWSTART|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=MAILPROTO)|[^EMAILCHARS](?=[EMAILCHARS]+@))))',
  '',
  {
    MAILPROTO: '(?:mailto|xmpp):',
    PROTO: PROTO_RX,
    WWWSTART: '(?<![^\\s*_~(])www\\.',
    EMAILCHARS: EMAIL_CHARS,
  }
);

// masks used by the emphasis pass: links / code / html are hidden so their
// asterisks never count as emphasis delimiters.
const BLOCKSKIP_RX = buildRx(
  'LINK|(?<!`)()CODE|HTML',
  'g',
  {
    LINK: '\\[(?:[^\\[\\]\\`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)',
    CODE: '(?<b>`+)[^`]+\\k<b>(?!`)',
    HTML: '<(?! )[^<>]*?>',
  }
);
const ANY_PUNCT_RX = buildRx('\\\\(PUNCT)', 'gu', { PUNCT: PUNCT });
const ANY_PUNCT_CODE_RX = buildRx(
  '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(PUNCT)',
  'gu',
  { PUNCT: PUNCT }
);

const I = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: TEXT_RX,
  emL: EM_L_RX,
  emRA: EM_RA_RX,
  emRU: EM_RU_RX,
  delL: DEL_L_RX,
  delR: DEL_R_RX,
  autolink: AUTOLINK_RX,
  tag: TAG_RX,
  link: LINK_RX,
  reflink: REFLINK_RX,
  nolink: NOLINK_RX,
  url: URL_RX,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  punct: buildRx('^((?![*_])PS)', 'u', { PS: PUNCTSPACE }),
  anyPunct: ANY_PUNCT_RX,
  anyPunctCode: ANY_PUNCT_CODE_RX,
  blockSkip: BLOCKSKIP_RX,
  reflinkSearch: REFLINK_SEARCH_RX,
};

// ---------------------------------------------------------------------------
// Small helpers. Each mirrors one helper from the marked baseline, rewritten
// in my own layout.

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ESC_CHAR = (ch) => ESC_MAP[ch];

// Escape HTML. With encode, every & is escaped; without, valid character
// references are left alone.
function escapeHtml(text, encode) {
  if (encode) {
    if (R.escTest.test(text)) return text.replace(R.escReplace, ESC_CHAR);
  } else if (R.escTestRaw.test(text)) {
    return text.replace(R.escReplaceRaw, ESC_CHAR);
  }
  return text;
}

// Decode numeric character references; a bare & becomes &amp;.
function unescapeHtml(text) {
  if (!R.numRef.test(text)) return text;
  return text.replace(R.numRefOrAmp, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 1114111 || (cp >= 55296 && cp <= 57343))
      return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Strip trailing characters equal to ch (or, with invert, not equal to ch).
function stripTrailing(text, ch, invert) {
  const n = text.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n; ) {
    const c = text.charAt(n - s - 1);
    if (c === ch && !invert) s++;
    else if (c !== ch && invert) s++;
    else break;
  }
  return text.slice(0, n - s);
}

// Drop trailing blank lines, but keep the text as-is when there is at most
// one trailing blank line.
function stripTrailingBlankLines(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && R.blankLine.test(lines[t]); ) t--;
  return lines.length - t <= 2 ? text : lines.slice(0, t + 1).join('\n');
}

// Normalise a link reference label: trim, collapse whitespace, fold case.
function normalizeLabel(text) {
  return text
    .trim()
    .replace(R.spaceRun, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// Expand tabs to spaces, tracking the column from startCol.
function expandTabs(text, startCol) {
  let col = startCol || 0;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const r = 4 - (col % 4);
      out += ' '.repeat(r);
      col += r;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Index of the first non-space char after replacing every tab with four
// spaces (the value String.search(/[^ ]/) returns on the replaced string,
// -1 when the string is all whitespace). Only leading whitespace matters,
// since the search stops at the first content char.
function leadNonSpace4(s) {
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4;
      i++;
    } else return col;
  }
  return -1;
}

// True when s ends with a blank line (a newline, optional spaces/tabs, a
// newline, optional spaces/tabs) — the /\n[ \t]*\n[ \t]*$/ test, done by
// hand so the list loop never pays for a regex here.
function hasDoubleBlankEnd(s) {
  let i = s.length;
  while (i > 0 && (s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || s.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || s.charCodeAt(i - 1) !== 10) return false;
  return true;
}

// True when src holds a line that could be a setext underline before the
// first blank line: a newline, at most three spaces, then '=' or '-'. A
// setext heading needs one in its opening paragraph, so the expensive
// lheading regex is skipped entirely when none is present there.
function hasSetextLine(src) {
  let i = src.indexOf('\n');
  while (i !== -1) {
    let j = i + 1;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(j) === 32) {
      j++;
      sp++;
    }
    const c = src.charCodeAt(j);
    if (c === 61 || c === 45) return true;
    // A blank line ends the opening paragraph: no underline can follow.
    if (c === 10) return false;
    if (c === 32 || c === 9) {
      // only spaces/tabs to end of line -> blank line
      let k = j;
      while (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9) k++;
      if (src.charCodeAt(k) === 10 || k >= src.length) return false;
    }
    i = src.indexOf('\n', j);
  }
  return false;
}
function urlStart(src, c0) {
  if (c0 === 104 || c0 === 72) {
    // h/H -> http:// or https://
    if (
      (src.charCodeAt(1) | 32) === 116 &&
      (src.charCodeAt(2) | 32) === 116 &&
      (src.charCodeAt(3) | 32) === 112
    ) {
      let j = 4;
      if ((src.charCodeAt(j) | 32) === 115) j++;
      if (
        src.charCodeAt(j) === 58 &&
        src.charCodeAt(j + 1) === 47 &&
        src.charCodeAt(j + 2) === 47
      )
        return true;
    }
  } else if (c0 === 102 || c0 === 70) {
    // f/F -> ftp://
    if (
      (src.charCodeAt(1) | 32) === 116 &&
      (src.charCodeAt(2) | 32) === 112 &&
      src.charCodeAt(3) === 58 &&
      src.charCodeAt(4) === 47 &&
      src.charCodeAt(5) === 47
    )
      return true;
  } else if (c0 === 119 || c0 === 87) {
    // w/W -> www.
    if (
      (src.charCodeAt(1) | 32) === 119 &&
      (src.charCodeAt(2) | 32) === 119 &&
      src.charCodeAt(3) === 46
    )
      return true;
  } else if (c0 === 109 || c0 === 77) {
    // m/M -> mailto:
    if (
      (src.charCodeAt(1) | 32) === 97 &&
      (src.charCodeAt(2) | 32) === 105 &&
      (src.charCodeAt(3) | 32) === 108 &&
      (src.charCodeAt(4) | 32) === 116 &&
      (src.charCodeAt(5) | 32) === 111 &&
      src.charCodeAt(6) === 58
    )
      return true;
  } else if (c0 === 120 || c0 === 88) {
    // x/X -> xmpp:
    if (
      (src.charCodeAt(1) | 32) === 109 &&
      (src.charCodeAt(2) | 32) === 112 &&
      (src.charCodeAt(3) | 32) === 112 &&
      src.charCodeAt(4) === 58
    )
      return true;
  }
  // email: a run of [A-Za-z0-9._+-] followed by '@'
  if (
    (c0 >= 48 && c0 <= 57) ||
    (c0 >= 65 && c0 <= 90) ||
    (c0 >= 97 && c0 <= 122) ||
    c0 === 46 ||
    c0 === 95 ||
    c0 === 43 ||
    c0 === 45
  ) {
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        c === 46 ||
        c === 95 ||
        c === 43 ||
        c === 45
      )
        i++;
      else break;
    }
    if (i > 0 && src.charCodeAt(i) === 64) return true;
  }
  return false;
}

// Find the first unmatched close paren in text: -1 none, -2 unclosed open.
function findClosingParen(text, parens) {
  if (text.indexOf(parens[0]) === -1 && text.indexOf(parens[1]) === -1)
    return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === parens[0]) depth++;
    else if (text[i] === parens[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes, honouring the column count.
function splitRow(text, count) {
  const t = text.replace(R.pipeFind, (m, off, str) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\'; ) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(R.pipeSplit);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count; ) cells.push('');
  }
  for (let s = 0; s < cells.length; s++)
    cells[s] = cells[s].trim().replace(R.pipeEsc, '|');
  return cells;
}

// Remove the fence's indent from each line of a fenced code body.
function fenceIndentComp(raw, body) {
  const m = R.fenceIndent.exec(raw);
  if (m === null) return body;
  const ind = m[1];
  return body
    .split('\n')
    .map((line) => {
      const o = R.leadSpaceTab.exec(line);
      if (o === null) return line;
      return line.slice(Math.min(o[0].length, ind.length));
    })
    .join('\n');
}

// True when the link label contains a <tag> or <autolink> that runs past
// the end of the label (so the [..] is not a link at all).
function hasAngleBracketTag(src, labelText, offset) {
  if (!labelText.includes('<')) return false;
  for (let i = 0; i < labelText.length; i++) {
    if (labelText[i] === '\\') {
      i++;
      continue;
    }
    if (labelText[i] === '`') {
      const m = I.code.exec(labelText.slice(i));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (labelText[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const o = I.tag.exec(rest) || I.autolink.exec(rest);
    if (o) {
      if (o[0].length > labelText.length - i) return true;
      i += o[0].length - 1;
    }
  }
  return false;
}

// Scan a (masked) source for the last delimiter run of each kind whose
// preceding character is not whitespace. The index recorded is the start
// of the run; -1 means no such run.
function scanDelimiters(masked) {
  let star = -1;
  let under = -1;
  let tilde = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? ' ' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === ch; ) i++;
    if (
      prev !== ' ' &&
      prev !== '\t' &&
      prev !== '\n' &&
      prev !== '\r' &&
      prev !== '\f'
    ) {
      if (ch === '~') tilde = s;
      else if (ch === '*') star = s;
      else under = s;
    }
    s = i - 1;
  }
  return { star, under, tilde };
}

// Does the text contain a link (inline or reference) that is not an image?
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(I.blockSkip)) {
    if (I.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(I.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(
        s.charAt(0) === '!' ||
        !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))
      ) &&
      !(r > 1 && linkInText(s.slice(1, r - 1), links))
    )
      return true;
  }
  return false;
}

// Build the masked source for the emphasis pass: links, code spans and
// html are hidden (same length, delimiter characters replaced) so their
// asterisks never count as emphasis delimiters.
function maskSrc(src, links, hasLinks) {
  let out = src;
  if (hasLinks && src.includes('[')) {
    const search = I.reflinkSearch;
    const replaceOne = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links))
          return (
            '[' +
            inner.replace(search, replaceOne) +
            '][' +
            'a'.repeat(r.length - o - 2) +
            ']'
          );
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    out = out.replace(search, replaceOne);
  }
  // The punctuation/code pass can only match a backslash escape or a code
  // span, so it is skipped when the text has neither a backslash nor a
  // backtick. The block-skip pass can only match a link, a code span or an
  // HTML tag, so it is skipped when none of '[', '`', '<' appear.
  if (out.includes('\\') || out.includes('`'))
    out = out.replace(
      I.anyPunctCode,
      (m, ticks, punct) =>
        punct
          ? '+'.repeat(m.length)
          : ticks
            ? ticks +
              m.slice(ticks.length, -ticks.length).replace(/`/g, '+') +
              ticks
            : m
    );
  if (out.includes('[') || out.includes('`') || out.includes('<'))
    out = out.replace(I.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return out;
}

// Encode an href the way a browser would, keeping %25 as a literal %.
function encodeHref(href) {
  try {
    return encodeURI(href).replace(R.pct25, '%');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes the remaining source and returns a token
// (or undefined when the construct does not match here). The masked source
// and its delimiter scan are passed in for the emphasis / strikethrough
// tokenizers, exactly as the baseline does it.

function makeLinkToken(match, href, title, raw, lexer) {
  const text = match[1].replace(R.linkBracketEscape, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRaw = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const nested = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (nested) {
      lexer.state.inRawBlock = savedRaw;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title: title || null,
    text,
    tokens,
  };
}

// Punctuation test used by the emphasis flanking rules: whitespace or
// punctuation, but never * or _.
const PUNCT_TEST = buildRx('^((?![*_])PS)', 'u', { PS: PUNCTSPACE });

function tokEscape(src) {
  const t = I.escape.exec(src);
  if (t) return { type: 'escape', raw: t[0], text: t[1] };
}

function tokTag(src, lexer) {
  const t = I.tag.exec(src);
  if (!t) return;
  if (!lexer.state.inLink && R.aTagOpen.test(t[0])) lexer.state.inLink = true;
  else if (lexer.state.inLink && R.aTagClose.test(t[0]))
    lexer.state.inLink = false;
  if (!lexer.state.inRawBlock && R.preTagOpen.test(t[0]))
    lexer.state.inRawBlock = true;
  else if (lexer.state.inRawBlock && R.preTagClose.test(t[0]))
    lexer.state.inRawBlock = false;
  return {
    type: 'html',
    raw: t[0],
    inLink: lexer.state.inLink,
    inRawBlock: lexer.state.inRawBlock,
    block: false,
    text: t[0],
  };
}

function tokLink(src, lexer) {
  if (lexer.state.linkParenPossible === false) return;
  const t = I.link.exec(src);
  if (!t) return;
  const off = t[0].charAt(0) === '!' ? 2 : 1;
  if (hasAngleBracketTag(src, t[1], off)) return;
  let hrefPart = t[2].trim();
  if (R.angleOpen.test(hrefPart)) {
    if (!R.angleClose.test(hrefPart)) return;
    const inner = stripTrailing(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - inner.length) % 2 === 0) return;
  } else {
    const close = findClosingParen(t[2], '()');
    if (close === -2) return;
    if (close > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + close;
      t[2] = t[2].substring(0, close);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const rawEnd = stripTrailing(t[0].slice(0, -1), '\\');
  if ((t[0].length - rawEnd.length) % 2 === 0) return;
  let href = t[2];
  let title = '';
  title = t[3] ? t[3].slice(1, -1) : '';
  href = href.trim();
  if (R.angleOpen.test(href)) href = href.slice(1, -1);
  return makeLinkToken(
    t,
    href && href.replace(I.anyPunct, '$1'),
    title && title.replace(I.anyPunct, '$1'),
    t[0],
    lexer
  );
}

function tokReflink(src, lexer) {
  const m = I.reflink.exec(src) || I.nolink.exec(src);
  if (!m) return;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasAngleBracketTag(src, m[1], off)) return;
  const ref = lexer.tokens.links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLinkToken(m, ref.href, ref.title, m[0], lexer);
}

function tokEmStrong(src, masked, prev, scan, lexer) {
  const s = I.emL.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return;
  const r = s[0][0];
  const samePrev = prev === r;
  const i = masked.length - src.length;
  let l = i;
  for (; l > 0 && masked[l - 1] === r; ) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!PUNCT_TEST.exec(p);
  if (l < i) prev = p;
  const u = l < i ? h : !!PUNCT_TEST.exec(prev);
  if (s[4] && R.alphaNum.test(prev)) return;
  const d = s[1] || s[3] || '';
  if (!d || !prev || u) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R3 =
      !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return;
    const A = r === '*' ? I.emRA : I.emRU;
    const v = r === '*' ? scan.star : scan.under;
    const Q = masked.length - src.length + k;
    if (v < Q) return;
    const rest = masked.slice(-src.length + k);
    const ee = v - Q;
    for (A.lastIndex = 0; ; ) {
      const c = A.exec(rest);
      if (c === null || c.index > ee) break;
      const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
      if (!g) continue;
      const b = [...g].length;
      if (c[3] || c[4]) {
        m += b;
        continue;
      } else if (c[5] || c[6] || R3) {
        if (samePrev && (c[5] || c[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      if ((m -= b), m > 0) continue;
      const bl = Math.min(b, b + m + f);
      const te = [...c[0]][0].length;
      const M = src.slice(0, k + c.index + te + bl);
      if (Math.min(k, bl) % 2) {
        const U = M.slice(1, -1);
        return {
          type: 'em',
          raw: M,
          text: U,
          tokens: lexer.inlineTokens(U),
        };
      }
      const ne = M.slice(2, -2);
      return {
        type: 'strong',
        raw: M,
        text: ne,
        tokens: lexer.inlineTokens(ne),
      };
    }
  }
}

function tokCodespan(src) {
  const t = I.code.exec(src);
  if (!t) return;
  let text = t[2].replace(R.nlGlobal, ' ');
  const hasNonSpace = R.nonSpace.test(text);
  const padded =
    R.spaceStart.test(text) && R.spaceEnd.test(text);
  if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: t[0], text };
}

function tokBr(src) {
  const t = I.br.exec(src);
  if (t) return { type: 'br', raw: t[0] };
}

function tokDel(src, masked, prev, scan, lexer) {
  const s = I.delL.exec(src);
  if (!s) return;
  // A ~~ run can open unless the next char is punctuation AND the previous
  // char is a non-punctuation, non-space char. (When the next char is not
  // punctuation the run opens regardless of what precedes it.)
  if (s[1] && prev && !PUNCT_TEST.exec(prev)) return;
  const o = [...s[0]].length - 1;
  const h = I.delR;
  const u = scan.tilde;
  const d = masked.length - src.length + o;
  if (u < d) return;
  const rest = masked.slice(-src.length + o);
  const k = u - d;
  let p = o;
  for (h.lastIndex = 0; ; ) {
    const c = h.exec(rest);
    if (c === null || c.index > k) break;
    const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (c[3] || c[4]) {
      p += l;
      continue;
    }
    if ((p -= l), p > 0) continue;
    const bl = Math.min(l, l + p);
    const te = [...c[0]][0].length;
    const raw = src.slice(0, o + c.index + te + bl);
    const text = raw.slice(o, -o);
    return {
      type: 'del',
      raw,
      text,
      tokens: lexer.inlineTokens(text),
    };
  }
}

function tokAutolink(src) {
  const t = I.autolink.exec(src);
  if (!t) return;
  let text;
  let href;
  if (t[2] === '@') {
    text = t[1];
    href = 'mailto:' + text;
  } else {
    text = t[1];
    href = text;
  }
  return {
    type: 'link',
    raw: t[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function tokUrl(src) {
  const t = I.url.exec(src);
  if (!t) return;
  let text;
  let href;
  if (t[2] === '@') {
    text = t[0];
    href = 'mailto:' + text;
  } else {
    let cur;
    do {
      cur = t[0];
      t[0] = I.backpedal.exec(t[0])?.[0] ?? '';
    } while (cur !== t[0]);
    text = t[0];
    href = t[1] === 'www.' ? 'http://' + t[0] : t[0];
  }
  return {
    type: 'link',
    raw: t[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

function tokInlineText(src, lexer) {
  const t = I.text.exec(src);
  if (!t) return;
  const inRaw = lexer.state.inRawBlock;
  return {
    type: 'text',
    raw: t[0],
    text: inRaw ? t[0] : unescapeHtml(t[0]),
    escaped: inRaw,
  };
}

// ---------------------------------------------------------------------------
// The lexer: turns source text into block tokens (each carrying its inline
// tokens, queued and filled in a second pass, as the baseline does it).

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.linkCount = 0;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
  }

  lex(src) {
    src = src.replace(R.crlf, '\n');
    this.blockTokens(src, this.tokens);
    for (let t = 0; t < this.inlineQueue.length; t++) {
      const n = this.inlineQueue[t];
      this.state.inRawBlock = false;
      this.inlineTokens(n.src, n.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue an inline tokenization; the tokens array is filled in later.
  inline(src) {
    const t = [];
    this.inlineQueue.push({ src, tokens: t });
    return t;
  }

  // -- block tokenizers ------------------------------------------------------

  tokSpace(src) {
    const t = B.newline.exec(src);
    if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
  }

  tokCode(src) {
    const t = B.code.exec(src);
    if (!t) return;
    const raw = stripTrailingBlankLines(t[0]);
    return {
      type: 'code',
      raw,
      codeBlockStyle: 'indented',
      text: raw.replace(R.codeIndent, ''),
    };
  }

  tokFences(src) {
    const t = B.fences.exec(src);
    if (!t) return;
    return {
      type: 'code',
      raw: t[0],
      lang: t[2] ? t[2].trim().replace(I.anyPunct, '$1') : t[2],
      text: fenceIndentComp(t[0], t[3] || ''),
    };
  }

  tokHeading(src) {
    const t = B.heading.exec(src);
    if (!t) return;
    let text = t[2].trim();
    if (R.hashEnd.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || R.spaceTabEnd.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: stripTrailing(t[0], '\n'),
      depth: t[1].length,
      text,
      tokens: this.inline(text),
    };
  }

  tokHr(src) {
    const t = B.hr.exec(src);
    if (t) return { type: 'hr', raw: stripTrailing(t[0], '\n') };
  }

  tokBlockquote(src) {
    const t = B.blockquote.exec(src);
    if (!t) return;
    let lines = stripTrailing(t[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let started = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (R.bqStart.test(lines[p])) {
          chunk.push(lines[p]);
          started = true;
        } else if (!started) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const h = chunk.join('\n');
      const u = h
        .replace(R.bqMarkSpace, (g, b, m) => b + expandTabs(m, b.length))
        .replace(R.bqSetext, '\n    $1')
        .replace(R.bqSetext2, '');
      raw = raw ? raw + '\n' + h : h;
      text = text ? text + '\n' + u : u;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(u, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const k = tokens.at(-1);
      if (
        k?.type === 'code' ||
        k?.type === 'heading' ||
        k?.type === 'hr' ||
        k?.type === 'html' ||
        k?.type === 'table'
      )
        break;
      if (k?.type === 'blockquote') {
        const g = k;
        const b = lines.join('\n');
        const m = g.raw + '\n' + b.replace(R.bqSetext2, '');
        const f = this.tokBlockquote(m);
        tokens[tokens.length - 1] = f;
        const y = m.substring(f.raw.length).replace(/^\n/, '');
        const left = y ? y.split('\n').length : 0;
        const taken = left ? lines.slice(0, -left) : lines;
        if (taken.length > 0) raw = raw + '\n' + taken.join('\n');
        text = text.substring(0, text.length - g.text.length) + f.text;
        lines = lines.slice(taken.length);
        if (lines.length > 0 && R.bqStart.test(lines[0])) continue;
        break;
      } else if (k?.type === 'list') {
        const g = k;
        const b = g.raw + '\n' + lines.join('\n');
        const m = this.tokList(b);
        tokens[tokens.length - 1] = m;
        const f =
          m.raw.length > g.raw.length
            ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length
            : 0;
        if (f > 0) {
          const y = lines.slice(0, f).join('\n');
          raw = raw + '\n' + y;
          text = text + '\n' + y;
        }
        lines = lines.slice(f);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  tokList(src) {
    const t = B.list.exec(src);
    if (!t) return;
    const orig = src;
    let rest = src;
    const used = () => orig.length - rest.length;
    let bullet = t[1].trim();
    const ordered = bullet.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bullet = ordered
      ? `\\d{1,9}\\${bullet.slice(-1)}`
      : `\\${bullet}`;
    const itemRe = itemRx(bullet);
    let p = false;
    while (rest) {
      let empty = false;
      let d = '';
      const m = itemRe.exec(rest);
      if (!m || B.hr.test(rest)) break;
      const k = used();
      rest = rest.substring(m[0].length);
      const g = m[2].split('\n', 1)[0];
      const b = m[1].length;
      let mm = g.replace(R.leadSpaceTab, (v) => expandTabs(v, b));
      const f = rest.split('\n', 1)[0];
      let y = !mm.trim();
      let ind = 0;
      if (y) ind = b + 1;
      else {
        ind = mm.search(R.nonSpace);
        ind = ind > 4 ? 1 : ind;
        d = mm.slice(ind);
        ind += b;
      }
      if (y && R.blankLine.test(f)) {
        rest = rest.substring(f.length + 1);
        empty = true;
      }
      const dParts = [d];
      if (!empty) {
        const nextBull = nextBullRx(ind);
        const hrR = hrAtRx(ind);
        const fenceR = fenceAtRx(ind);
        const headR = headingAtRx(ind);
        const htmlR = htmlAtRx(ind);
        const bqR = bqAtRx(ind);
        while (rest) {
          const nl = rest.indexOf('\n');
          const f2 = nl === -1 ? rest : rest.slice(0, nl);
          // One scan of the leading whitespace gives the tab-expanded
          // column, whether a tab is present, and whether the line is
          // blank — no regex, no trim, no replace when there is no tab.
          let col = 0;
          let li = 0;
          let hasTab = false;
          while (li < f2.length) {
            const cc = f2.charCodeAt(li);
            if (cc === 32) {
              col++;
              li++;
            } else if (cc === 9) {
              hasTab = true;
              col += 4 - (col % 4);
              li++;
            } else break;
          }
          const blank = li === f2.length;
          const Z = hasTab
            ? expandTabs(f2.slice(0, li), 0) + f2.slice(li)
            : f2;
          const zFirst = hasTab ? col : li;
          // Break-test dispatch on the first content char: only the
          // regexes that could match that opener are run.
          const fc = li < f2.length ? f2.charCodeAt(li) : -1;
          let isBreak = false;
          if (fc === 96 || fc === 126) isBreak = fenceR.test(f2);
          else if (fc === 35) isBreak = headR.test(f2);
          else if (fc === 60) isBreak = htmlR.test(f2);
          else if (fc === 62) isBreak = bqR.test(f2);
          else if (fc === 45 || fc === 43 || fc === 42)
            isBreak = nextBull.test(f2) || hrR.test(f2);
          else if (fc >= 48 && fc <= 57) isBreak = nextBull.test(f2);
          else if (fc === 95) isBreak = hrR.test(f2);
          if (isBreak) break;
          if (zFirst >= ind || blank) dParts.push(Z.slice(ind));
          else {
            if (
              y ||
              leadNonSpace4(mm) >= 4 ||
              fenceR.test(mm) ||
              headR.test(mm) ||
              htmlR.test(mm) ||
              hrR.test(mm)
            )
              break;
            const qe =
              /^ {0,3}(?:=+|-+) *$/.test(f2) &&
              B.lheading.test(mm + '\n' + f2)
                ? '    ' + Z.replace(/^ {0,3}/, '')
                : f2;
            dParts.push(qe);
          }
          y = blank;
          rest = nl === -1 ? '' : rest.slice(nl + 1);
          mm = Z.slice(ind);
        }
      }
      d = dParts.join('\n');
      const A = orig.slice(k, used());
      if (!list.loose) {
        if (p) list.loose = true;
        else if (hasDoubleBlankEnd(A)) p = true;
      }
      list.items.push({
        type: 'list_item',
        raw: A,
        task: R.listIsTask.test(d),
        loose: false,
        text: d,
        tokens: [],
      });
    }
    const h = list.items.at(-1);
    if (h) {
      h.raw = h.raw.trimEnd();
      h.text = h.text.trimEnd();
    } else return;
    list.raw = orig.slice(0, used()).trimEnd();
    for (const u of list.items) {
      this.state.top = false;
      u.tokens = this.blockTokens(u.text, []);
      if (!list.loose) {
        const spaces = u.tokens.filter((g) => g.type === 'space');
        if (spaces.length > 0 && spaces.some((g) => R.anyLine.test(g.raw)))
          list.loose = true;
      }
    }
    for (const u of list.items) {
      const d = u.tokens[0];
      if (u.task && (d?.type === 'text' || d?.type === 'paragraph')) {
        u.text = u.text.replace(R.listTaskStrip, '');
        d.raw = d.raw.replace(R.listTaskStrip, '');
        d.text = d.text.replace(R.listTaskStrip, '');
        for (let g = this.inlineQueue.length - 1; g >= 0; g--) {
          if (R.listIsTask.test(this.inlineQueue[g].src)) {
            this.inlineQueue[g].src = this.inlineQueue[g].src.replace(
              R.listTaskStrip,
              ''
            );
            break;
          }
        }
        const k = R.listTaskBox.exec(u.raw);
        if (k) {
          const g = {
            type: 'checkbox',
            raw: k[0] + ' ',
            checked: k[0] !== '[ ]',
          };
          u.checked = g.checked;
          if (list.loose) {
            if (
              u.tokens[0] &&
              ['paragraph', 'text'].includes(u.tokens[0].type) &&
              'tokens' in u.tokens[0] &&
              u.tokens[0].tokens
            ) {
              u.tokens[0].raw = g.raw + u.tokens[0].raw;
              u.tokens[0].text = g.raw + u.tokens[0].text;
              u.tokens[0].tokens.unshift(g);
            } else {
              u.tokens.unshift({
                type: 'paragraph',
                raw: g.raw,
                text: g.raw,
                tokens: [g],
              });
            }
          } else {
            u.tokens.unshift(g);
          }
        }
      } else if (u.task) u.task = false;
    }
    if (list.loose)
      for (const u of list.items) {
        u.loose = true;
        for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
      }
    return list;
  }

  tokHtml(src) {
    const t = B.html.exec(src);
    if (!t) return;
    const raw = stripTrailingBlankLines(t[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style',
      text: raw,
    };
  }

  tokDef(src) {
    const t = B.def.exec(src);
    if (!t) return;
    if (!R.angleOpen.test(t[2]) && findClosingParen(t[2], '()') !== -1)
      return;
    return {
      type: 'def',
      tag: normalizeLabel(t[1]),
      raw: stripTrailing(t[0], '\n'),
      href: t[2]
        ? t[2].replace(R.hrefAngles, '$1').replace(I.anyPunct, '$1')
        : '',
      title: t[3]
        ? t[3].substring(1, t[3].length - 1).replace(I.anyPunct, '$1')
        : t[3],
    };
  }

  tokTable(src) {
    const t = B.table.exec(src);
    if (!t || !R.tableDelim.test(t[2])) return;
    const headerCells = splitRow(t[1]);
    const delimCells = t[2].replace(R.tableAlignTrim, '').split('|');
    const bodyRows = t[3]?.trim()
      ? t[3].replace(R.tableRowBlank, '').split('\n')
      : [];
    const table = {
      type: 'table',
      raw: stripTrailing(t[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };
    if (headerCells.length === delimCells.length) {
      for (const cell of delimCells) {
        if (R.alignRight.test(cell)) table.align.push('right');
        else if (R.alignCenter.test(cell)) table.align.push('center');
        else if (R.alignLeft.test(cell)) table.align.push('left');
        else table.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++)
        table.header.push({
          text: headerCells[i],
          tokens: this.inline(headerCells[i]),
          header: true,
          align: table.align[i],
        });
      for (const row of bodyRows)
        table.rows.push(
          splitRow(row, table.header.length).map((cell, p) => ({
            text: cell,
            tokens: this.inline(cell),
            header: false,
            align: table.align[p],
          }))
        );
      return table;
    }
  }

  tokLheading(src) {
    if (!hasSetextLine(src)) return;
    const t = B.lheading.exec(src);
    if (!t) return;
    const text = t[1].trim();
    return {
      type: 'heading',
      raw: stripTrailing(t[0], '\n'),
      depth: t[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: this.inline(text),
    };
  }

  tokParagraph(src) {
    const t = B.paragraph.exec(src);
    if (!t) return;
    const text =
      t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
    return { type: 'paragraph', raw: t[0], text, tokens: this.inline(text) };
  }

  tokBlockText(src) {
    const t = B.text.exec(src);
    if (!t) return;
    return { type: 'text', raw: t[0], text: t[0], tokens: this.inline(t[0]) };
  }

  // -- the block loop ---------------------------------------------------------

  blockTokens(src, out, inBlock) {
    out = out || [];
    let s = 1 / 0;
    let n = inBlock || false;
    while (src) {
      if (src.length < s) s = src.length;
      else break; // infinite loop guard
      let r;
      if ((r = this.tokSpace(src))) {
        src = src.substring(r.raw.length);
        const i = out.at(-1);
        if (r.raw.length === 1 && i !== undefined) i.raw += '\n';
        else out.push(r);
        continue;
      }
      if ((r = this.tokCode(src))) {
        src = src.substring(r.raw.length);
        const i = out.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.at(-1).src = i.text;
        } else out.push(r);
        continue;
      }
      if ((r = this.tokFences(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      if ((r = this.tokHeading(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      if ((r = this.tokHr(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      if ((r = this.tokBlockquote(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      if ((r = this.tokList(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      if ((r = this.tokHtml(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      if ((r = this.tokDef(src))) {
        src = src.substring(r.raw.length);
        const i = out.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.raw;
          this.inlineQueue.at(-1).src = i.text;
        } else {
          if (!this.tokens.links[r.tag]) {
            this.tokens.links[r.tag] = { href: r.href, title: r.title };
            this.linkCount++;
          }
          out.push(r);
        }
        continue;
      }
      if ((r = this.tokTable(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      if ((r = this.tokLheading(src))) {
        src = src.substring(r.raw.length);
        out.push(r);
        continue;
      }
      const o = src;
      if (this.state.top && (r = this.tokParagraph(o))) {
        const i = out.at(-1);
        if (n && i?.type === 'paragraph') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = i.text;
        } else out.push(r);
        n = o.length !== src.length;
        src = src.substring(r.raw.length);
        continue;
      }
      if ((r = this.tokBlockText(src))) {
        src = src.substring(r.raw.length);
        const i = out.at(-1);
        if (i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = i.text;
        } else out.push(r);
        continue;
      }
      if (src) break; // infinite loop guard
    }
    this.state.top = true;
    return out;
  }

  // -- the inline loop --------------------------------------------------------

  inlineTokens(src, tokens) {
    tokens = tokens || [];
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible =
      savedParen && src.includes(')');
    try {
      return this.inlineLoop(src, tokens);
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  }

  inlineLoop(src, tokens) {
    // Mask links / code / html only when a delimiter is present at all, and
    // only when the text holds a character the mask could actually hide
    // (a '[', backtick, '<' or backslash); otherwise the mask is the
    // source itself and the scan runs on it directly.
    let masked = src;
    let scan = null;
    if (src.includes('*') || src.includes('_') || src.includes('~')) {
      if (
        src.includes('[') ||
        src.includes('`') ||
        src.includes('<') ||
        src.includes('\\')
      )
        masked = maskSrc(src, this.tokens.links, this.linkCount > 0);
      scan = scanDelimiters(masked);
    }
    let justText = false;
    let prev = '';
    let guard = 1 / 0;
    while (src) {
      if (src.length < guard) guard = src.length;
      else break; // infinite loop guard
      if (!justText) prev = '';
      justText = false;
      const c0 = src.charCodeAt(0);
      let tok;
      // First-character dispatch: only the tokenizers that can open on
      // this character are attempted, so plain text never pays for the
      // tag / link / reflink regexes.
      if (c0 === 92) {
        // backslash: escape, then hard break, then text
        if ((tok = tokEscape(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if ((tok = tokBr(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c0 === 60) {
        // '<': tag, then autolink
        if ((tok = tokTag(src, this))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if ((tok = tokAutolink(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c0 === 91 || (c0 === 33 && src.charCodeAt(1) === 91)) {
        // '[' or '![': link, then reflink
        if ((tok = tokLink(src, this))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if ((tok = tokReflink(src, this))) {
          src = src.substring(tok.raw.length);
          const p = tokens[tokens.length - 1];
          if (tok.type === 'text' && p?.type === 'text') {
            p.raw += tok.raw;
            p.text += tok.text;
          } else tokens.push(tok);
          continue;
        }
      } else if (c0 === 42) {
        // '*': emphasis only (a URL/email cannot start with '*')
        if (
          scan &&
          (tok = tokEmStrong(src, masked, prev, scan, this))
        ) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c0 === 95) {
        // '_': emphasis, then a URL/email (an email local part may start
        // with '_', e.g. _leading@example.com)
        if (
          scan &&
          (tok = tokEmStrong(src, masked, prev, scan, this))
        ) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
        if (
          !this.state.inLink &&
          urlStart(src, c0) &&
          (tok = tokUrl(src))
        ) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c0 === 126) {
        // '~': strikethrough
        if (scan && (tok = tokDel(src, masked, prev, scan, this))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c0 === 96) {
        // backtick: code span
        if ((tok = tokCodespan(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (c0 === 32) {
        // space: hard break, then text
        if ((tok = tokBr(src))) {
          src = src.substring(tok.raw.length);
          tokens.push(tok);
          continue;
        }
      } else if (
        !this.state.inLink &&
        urlStart(src, c0) &&
        (tok = tokUrl(src))
      ) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = tokInlineText(src, this))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.charCodeAt(tok.raw.length - 1) !== 95)
          prev = tok.raw.charAt(tok.raw.length - 1);
        justText = true;
        const p = tokens[tokens.length - 1];
        if (p?.type === 'text') {
          p.raw += tok.raw;
          p.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) break; // infinite loop guard
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Rendering. The HTML renderer turns block tokens into HTML; the plain-text
// renderer does the same job for image alt text (no tags, just the words).

class Renderer {
  space() {
    return '';
  }
  code(tok) {
    const lang = (tok.lang || '').match(R.nonSpaceStart)?.[0];
    const body = tok.text
      ? tok.text.replace(R.nlEnd, '') + '\n'
      : '';
    const inner = tok.escaped ? body : escapeHtml(body, true);
    return lang
      ? '<pre><code class="language-' +
          escapeHtml(lang) +
          '">' +
          inner +
          '</code></pre>\n'
      : '<pre><code>' + inner + '</code></pre>\n';
  }
  blockquote(tok) {
    return '<blockquote>\n' + this.parser.parse(tok.tokens) + '</blockquote>\n';
  }
  html(tok) {
    return tok.text;
  }
  def() {
    return '';
  }
  heading(tok) {
    return (
      '<h' +
      tok.depth +
      '>' +
      this.parser.parseInline(tok.tokens) +
      '</h' +
      tok.depth +
      '>\n'
    );
  }
  hr() {
    return '<hr>\n';
  }
  list(tok) {
    let body = '';
    for (const item of tok.items) body += this.listitem(item);
    const tag = tok.ordered ? 'ol' : 'ul';
    const start =
      tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
    return '<' + tag + start + '>\n' + body + '</' + tag + '>\n';
  }
  listitem(tok) {
    return '<li>' + this.parser.parse(tok.tokens) + '</li>\n';
  }
  checkbox(tok) {
    return (
      '<input ' +
      (tok.checked ? 'checked="" ' : '') +
      'disabled="" type="checkbox"> '
    );
  }
  paragraph(tok) {
    return '<p>' + this.parser.parseInline(tok.tokens) + '</p>\n';
  }
  table(tok) {
    let headCells = '';
    for (const cell of tok.header) headCells += this.tablecell(cell);
    const head = this.tablerow({ text: headCells });
    let body = '';
    for (const row of tok.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = '<tbody>' + body + '</tbody>';
    return '<table>\n<thead>\n' + head + '</thead>\n' + body + '</table>\n';
  }
  tablerow(tok) {
    return '<tr>\n' + tok.text + '</tr>\n';
  }
  tablecell(tok) {
    const tag = tok.header ? 'th' : 'td';
    const open = tok.align ? '<' + tag + ' align="' + tok.align + '">' : '<' + tag + '>';
    return (
      open + this.parser.parseInline(tok.tokens) + '</' + tag + '>\n'
    );
  }
  strong(tok) {
    return '<strong>' + this.parser.parseInline(tok.tokens) + '</strong>';
  }
  em(tok) {
    return '<em>' + this.parser.parseInline(tok.tokens) + '</em>';
  }
  codespan(tok) {
    return '<code>' + escapeHtml(tok.text, true) + '</code>';
  }
  br() {
    return '<br>';
  }
  del(tok) {
    return '<del>' + this.parser.parseInline(tok.tokens) + '</del>';
  }
  link(tok) {
    const body = tok.autolink
      ? escapeHtml(tok.text, true)
      : this.parser.parseInline(tok.tokens);
    const href = encodeHref(tok.href);
    if (href === null) return body;
    let out = '<a href="' + escapeHtml(href, tok.autolink) + '"';
    if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
    return out + '>' + body + '</a>';
  }
  image(tok) {
    let alt = tok.text;
    if (tok.tokens) alt = this.parser.parseInline(tok.tokens, this.parser.textRenderer);
    const href = encodeHref(tok.href);
    if (href === null) return escapeHtml(alt);
    let out =
      '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"';
    if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
    return out + '>';
  }
  text(tok) {
    if ('tokens' in tok && tok.tokens)
      return this.parser.parseInline(tok.tokens);
    if ('escaped' in tok && tok.escaped) return tok.text;
    return escapeHtml(tok.text);
  }
}

// Plain-text renderer, used for image alt attributes.
class TextRenderer {
  strong(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }
  em(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }
  codespan(tok) {
    return tok.text;
  }
  del(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }
  html(tok) {
    return tok.text;
  }
  text(tok) {
    return tok.text;
  }
  link(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }
  image(tok) {
    return tok.tokens
      ? this.parser.parseInline(tok.tokens, this)
      : tok.text;
  }
  br() {
    return '';
  }
  checkbox(tok) {
    return tok.raw;
  }
}

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.textRenderer = new TextRenderer();
    this.renderer.parser = this;
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'space':
          out += this.renderer.space(tok);
          break;
        case 'hr':
          out += this.renderer.hr(tok);
          break;
        case 'heading':
          out += this.renderer.heading(tok);
          break;
        case 'code':
          out += this.renderer.code(tok);
          break;
        case 'table':
          out += this.renderer.table(tok);
          break;
        case 'blockquote':
          out += this.renderer.blockquote(tok);
          break;
        case 'list':
          out += this.renderer.list(tok);
          break;
        case 'checkbox':
          out += this.renderer.checkbox(tok);
          break;
        case 'html':
          out += this.renderer.html(tok);
          break;
        case 'def':
          out += this.renderer.def(tok);
          break;
        case 'paragraph':
          out += this.renderer.paragraph(tok);
          break;
        case 'text':
          out += this.renderer.text(tok);
          break;
        default:
          throw new Error('Token with "' + tok.type + '" type was not found.');
      }
    }
    return out;
  }

  parseInline(tokens, renderer) {
    const r = renderer || this.renderer;
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'escape':
        case 'text':
          out += r.text(tok);
          break;
        case 'html':
          out += r.html(tok);
          break;
        case 'link':
          out += r.link(tok);
          break;
        case 'image':
          out += r.image(tok);
          break;
        case 'checkbox':
          out += r.checkbox(tok);
          break;
        case 'strong':
          out += r.strong(tok);
          break;
        case 'em':
          out += r.em(tok);
          break;
        case 'codespan':
          out += r.codespan(tok);
          break;
        case 'br':
          out += r.br(tok);
          break;
        case 'del':
          out += r.del(tok);
          break;
        default:
          throw new Error('Token with "' + tok.type + '" type was not found.');
      }
    }
    return out;
  }
}

function renderDoc(src) {
  const lexer = new Lexer();
  const tokens = lexer.lex(src);
  const parser = new Parser();
  return parser.parse(tokens);
}
