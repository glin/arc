
import { createRequire } from "node:module";


var jobs = [];
var checks = [];
var test = (name, fn) => jobs.push({ name, fn });
test.each = (values) => (name, fn) => {
  for (const v of values) test(name, () => fn(...Array.isArray(v) ? v : [v]));
};
async function finish() {
  for (let i = 0; i < jobs.length; i++) {
    let pass = true;
    try {
      await jobs[i].fn();
    } catch (e) {
      console.error(e.stack);
      pass = false;
    }
    checks.push({ id: "check-" + i, role: jobs[i].name.startsWith("ordinary") ? "normal" : "symptom", pass });
  }
  console.log(JSON.stringify({ checks }));
}


var BACKGROUND_SCAN_BYTES = 1024 * 1024;


function getDefaults() {
  return {
    async: false,
    baseUrl: null,
    breaks: false,
    extensions: null,
    gfm: true,
    headerIds: true,
    headerPrefix: "",
    highlight: null,
    hooks: null,
    langPrefix: "language-",
    mangle: true,
    pedantic: false,
    renderer: null,
    sanitize: false,
    sanitizer: null,
    silent: false,
    smartypants: false,
    tokenizer: null,
    walkTokens: null,
    xhtml: false
  };
}
var defaults = getDefaults();
function changeDefaults(newDefaults) {
  defaults = newDefaults;
}
var escapeTest = /[&<>"']/;
var escapeReplace = new RegExp(escapeTest.source, "g");
var escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
var escapeReplaceNoEncode = new RegExp(escapeTestNoEncode.source, "g");
var escapeReplacements = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
var getEscapeReplacement = (ch) => escapeReplacements[ch];
function escape(html, encode) {
  if (encode) {
    if (escapeTest.test(html)) {
      return html.replace(escapeReplace, getEscapeReplacement);
    }
  } else {
    if (escapeTestNoEncode.test(html)) {
      return html.replace(escapeReplaceNoEncode, getEscapeReplacement);
    }
  }
  return html;
}
var unescapeTest = /&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/ig;
function unescape(html) {
  return html.replace(unescapeTest, (_, n) => {
    n = n.toLowerCase();
    if (n === "colon") return ":";
    if (n.charAt(0) === "#") {
      return n.charAt(1) === "x" ? String.fromCharCode(parseInt(n.substring(2), 16)) : String.fromCharCode(+n.substring(1));
    }
    return "";
  });
}
var caret = /(^|[^\[])\^/g;
function edit(regex, opt) {
  regex = typeof regex === "string" ? regex : regex.source;
  opt = opt || "";
  const obj = {
    replace: (name, val) => {
      val = val.source || val;
      val = val.replace(caret, "$1");
      regex = regex.replace(name, val);
      return obj;
    },
    getRegex: () => {
      return new RegExp(regex, opt);
    }
  };
  return obj;
}
var nonWordAndColonTest = /[^\w:]/g;
var originIndependentUrl = /^$|^[a-z][a-z0-9+.-]*:|^[?#]/i;
function cleanUrl(sanitize, base, href) {
  if (sanitize) {
    let prot;
    try {
      prot = decodeURIComponent(unescape(href)).replace(nonWordAndColonTest, "").toLowerCase();
    } catch (e) {
      return null;
    }
    if (prot.indexOf("javascript:") === 0 || prot.indexOf("vbscript:") === 0 || prot.indexOf("data:") === 0) {
      return null;
    }
  }
  if (base && !originIndependentUrl.test(href)) {
    href = resolveUrl(base, href);
  }
  try {
    href = encodeURI(href).replace(/%25/g, "%");
  } catch (e) {
    return null;
  }
  return href;
}
var baseUrls = {};
var justDomain = /^[^:]+:\/*[^/]*$/;
var protocol = /^([^:]+:)[\s\S]*$/;
var domain = /^([^:]+:\/*[^/]*)[\s\S]*$/;
function resolveUrl(base, href) {
  if (!baseUrls[" " + base]) {
    if (justDomain.test(base)) {
      baseUrls[" " + base] = base + "/";
    } else {
      baseUrls[" " + base] = rtrim(base, "/", true);
    }
  }
  base = baseUrls[" " + base];
  const relativeBase = base.indexOf(":") === -1;
  if (href.substring(0, 2) === "//") {
    if (relativeBase) {
      return href;
    }
    return base.replace(protocol, "$1") + href;
  } else if (href.charAt(0) === "/") {
    if (relativeBase) {
      return href;
    }
    return base.replace(domain, "$1") + href;
  } else {
    return base + href;
  }
}
var noopTest = { exec: function noopTest2() {
} };
function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false, curr = offset;
    while (--curr >= 0 && str[curr] === "\\") escaped = !escaped;
    if (escaped) {
      return "|";
    } else {
      return " |";
    }
  }), cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells[cells.length - 1].trim()) {
    cells.pop();
  }
  if (cells.length > count) {
    cells.splice(count);
  } else {
    while (cells.length < count) cells.push("");
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, "|");
  }
  return cells;
}
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return "";
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}
function findClosingBracket(str, b) {
  if (str.indexOf(b[1]) === -1) {
    return -1;
  }
  const l = str.length;
  let level = 0, i = 0;
  for (; i < l; i++) {
    if (str[i] === "\\") {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  return -1;
}
function checkSanitizeDeprecation(opt) {
  if (opt && opt.sanitize && !opt.silent) {
    console.warn("marked(): sanitize and sanitizer parameters are deprecated since version 0.7.0, should not be used and will be removed in the future. Read more here: https://marked.js.org/#/USING_ADVANCED.md#options");
  }
}
function repeatString(pattern, count) {
  if (count < 1) {
    return "";
  }
  let result = "";
  while (count > 1) {
    if (count & 1) {
      result += pattern;
    }
    count >>= 1;
    pattern += pattern;
  }
  return result + pattern;
}
function outputLink(cap, link, raw, lexer2) {
  const href = link.href;
  const title = link.title ? escape(link.title) : null;
  const text = cap[1].replace(/\\([\[\]])/g, "$1");
  if (cap[0].charAt(0) !== "!") {
    lexer2.state.inLink = true;
    const token = {
      type: "link",
      raw,
      href,
      title,
      text,
      tokens: lexer2.inlineTokens(text)
    };
    lexer2.state.inLink = false;
    return token;
  }
  return {
    type: "image",
    raw,
    href,
    title,
    text: escape(text)
  };
}
function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(/^(\s+)(?:```)/);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text.split("\n").map((node) => {
    const matchIndentInNode = node.match(/^\s+/);
    if (matchIndentInNode === null) {
      return node;
    }
    const [indentInNode] = matchIndentInNode;
    if (indentInNode.length >= indentToCode.length) {
      return node.slice(indentToCode.length);
    }
    return node;
  }).join("\n");
}
var Tokenizer = class {
  constructor(options2) {
    this.options = options2 || defaults;
  }
  space(src) {
    const cap = this.rules.block.newline.exec(src);
    if (cap && cap[0].length > 0) {
      return {
        type: "space",
        raw: cap[0]
      };
    }
  }
  code(src) {
    const cap = this.rules.block.code.exec(src);
    if (cap) {
      const text = cap[0].replace(/^ {1,4}/gm, "");
      return {
        type: "code",
        raw: cap[0],
        codeBlockStyle: "indented",
        text: !this.options.pedantic ? rtrim(text, "\n") : text
      };
    }
  }
  fences(src) {
    const cap = this.rules.block.fences.exec(src);
    if (cap) {
      const raw = cap[0];
      const text = indentCodeCompensation(raw, cap[3] || "");
      return {
        type: "code",
        raw,
        lang: cap[2] ? cap[2].trim().replace(this.rules.inline._escapes, "$1") : cap[2],
        text
      };
    }
  }
  heading(src) {
    const cap = this.rules.block.heading.exec(src);
    if (cap) {
      let text = cap[2].trim();
      if (/#$/.test(text)) {
        const trimmed = rtrim(text, "#");
        if (this.options.pedantic) {
          text = trimmed.trim();
        } else if (!trimmed || / $/.test(trimmed)) {
          text = trimmed.trim();
        }
      }
      return {
        type: "heading",
        raw: cap[0],
        depth: cap[1].length,
        text,
        tokens: this.lexer.inline(text)
      };
    }
  }
  hr(src) {
    const cap = this.rules.block.hr.exec(src);
    if (cap) {
      return {
        type: "hr",
        raw: cap[0]
      };
    }
  }
  blockquote(src) {
    const cap = this.rules.block.blockquote.exec(src);
    if (cap) {
      const text = cap[0].replace(/^ *>[ \t]?/gm, "");
      const top = this.lexer.state.top;
      this.lexer.state.top = true;
      const tokens = this.lexer.blockTokens(text);
      this.lexer.state.top = top;
      return {
        type: "blockquote",
        raw: cap[0],
        tokens,
        text
      };
    }
  }
  list(src) {
    let cap = this.rules.block.list.exec(src);
    if (cap) {
      let raw, istask, ischecked, indent, i, blankLine, endsWithBlankLine, line, nextLine, rawLine, itemContents, endEarly;
      let bull = cap[1].trim();
      const isordered = bull.length > 1;
      const list = {
        type: "list",
        raw: "",
        ordered: isordered,
        start: isordered ? +bull.slice(0, -1) : "",
        loose: false,
        items: []
      };
      bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
      if (this.options.pedantic) {
        bull = isordered ? bull : "[*+-]";
      }
      const itemRegex = new RegExp(`^( {0,3}${bull})((?:[	 ][^\\n]*)?(?:\\n|$))`);
      while (src) {
        endEarly = false;
        if (!(cap = itemRegex.exec(src))) {
          break;
        }
        if (this.rules.block.hr.test(src)) {
          break;
        }
        raw = cap[0];
        src = src.substring(raw.length);
        line = cap[2].split("\n", 1)[0].replace(/^\t+/, (t) => " ".repeat(3 * t.length));
        nextLine = src.split("\n", 1)[0];
        if (this.options.pedantic) {
          indent = 2;
          itemContents = line.trimLeft();
        } else {
          indent = cap[2].search(/[^ ]/);
          indent = indent > 4 ? 1 : indent;
          itemContents = line.slice(indent);
          indent += cap[1].length;
        }
        blankLine = false;
        if (!line && /^ *$/.test(nextLine)) {
          raw += nextLine + "\n";
          src = src.substring(nextLine.length + 1);
          endEarly = true;
        }
        if (!endEarly) {
          const nextBulletRegex = new RegExp(`^ {0,${Math.min(3, indent - 1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`);
          const hrRegex = new RegExp(`^ {0,${Math.min(3, indent - 1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`);
          const fencesBeginRegex = new RegExp(`^ {0,${Math.min(3, indent - 1)}}(?:\`\`\`|~~~)`);
          const headingBeginRegex = new RegExp(`^ {0,${Math.min(3, indent - 1)}}#`);
          while (src) {
            rawLine = src.split("\n", 1)[0];
            nextLine = rawLine;
            if (this.options.pedantic) {
              nextLine = nextLine.replace(/^ {1,4}(?=( {4})*[^ ])/g, "  ");
            }
            if (fencesBeginRegex.test(nextLine)) {
              break;
            }
            if (headingBeginRegex.test(nextLine)) {
              break;
            }
            if (nextBulletRegex.test(nextLine)) {
              break;
            }
            if (hrRegex.test(src)) {
              break;
            }
            if (nextLine.search(/[^ ]/) >= indent || !nextLine.trim()) {
              itemContents += "\n" + nextLine.slice(indent);
            } else {
              if (blankLine) {
                break;
              }
              if (line.search(/[^ ]/) >= 4) {
                break;
              }
              if (fencesBeginRegex.test(line)) {
                break;
              }
              if (headingBeginRegex.test(line)) {
                break;
              }
              if (hrRegex.test(line)) {
                break;
              }
              itemContents += "\n" + nextLine;
            }
            if (!blankLine && !nextLine.trim()) {
              blankLine = true;
            }
            raw += rawLine + "\n";
            src = src.substring(rawLine.length + 1);
            line = nextLine.slice(indent);
          }
        }
        if (!list.loose) {
          if (endsWithBlankLine) {
            list.loose = true;
          } else if (/\n *\n *$/.test(raw)) {
            endsWithBlankLine = true;
          }
        }
        if (this.options.gfm) {
          istask = /^\[[ xX]\] /.exec(itemContents);
          if (istask) {
            ischecked = istask[0] !== "[ ] ";
            itemContents = itemContents.replace(/^\[[ xX]\] +/, "");
          }
        }
        list.items.push({
          type: "list_item",
          raw,
          task: !!istask,
          checked: ischecked,
          loose: false,
          text: itemContents
        });
        list.raw += raw;
      }
      list.items[list.items.length - 1].raw = raw.trimRight();
      list.items[list.items.length - 1].text = itemContents.trimRight();
      list.raw = list.raw.trimRight();
      const l = list.items.length;
      for (i = 0; i < l; i++) {
        this.lexer.state.top = false;
        list.items[i].tokens = this.lexer.blockTokens(list.items[i].text, []);
        if (!list.loose) {
          const spacers = list.items[i].tokens.filter((t) => t.type === "space");
          const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => /\n.*\n/.test(t.raw));
          list.loose = hasMultipleLineBreaks;
        }
      }
      if (list.loose) {
        for (i = 0; i < l; i++) {
          list.items[i].loose = true;
        }
      }
      return list;
    }
  }
  html(src) {
    const cap = this.rules.block.html.exec(src);
    if (cap) {
      const token = {
        type: "html",
        raw: cap[0],
        pre: !this.options.sanitizer && (cap[1] === "pre" || cap[1] === "script" || cap[1] === "style"),
        text: cap[0]
      };
      if (this.options.sanitize) {
        const text = this.options.sanitizer ? this.options.sanitizer(cap[0]) : escape(cap[0]);
        token.type = "paragraph";
        token.text = text;
        token.tokens = this.lexer.inline(text);
      }
      return token;
    }
  }
  def(src) {
    const cap = this.rules.block.def.exec(src);
    if (cap) {
      const tag = cap[1].toLowerCase().replace(/\s+/g, " ");
      const href = cap[2] ? cap[2].replace(/^<(.*)>$/, "$1").replace(this.rules.inline._escapes, "$1") : "";
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(this.rules.inline._escapes, "$1") : cap[3];
      return {
        type: "def",
        tag,
        raw: cap[0],
        href,
        title
      };
    }
  }
  table(src) {
    const cap = this.rules.block.table.exec(src);
    if (cap) {
      const item = {
        type: "table",
        header: splitCells(cap[1]).map((c) => {
          return { text: c };
        }),
        align: cap[2].replace(/^ *|\| *$/g, "").split(/ *\| */),
        rows: cap[3] && cap[3].trim() ? cap[3].replace(/\n[ \t]*$/, "").split("\n") : []
      };
      if (item.header.length === item.align.length) {
        item.raw = cap[0];
        let l = item.align.length;
        let i, j, k, row;
        for (i = 0; i < l; i++) {
          if (/^ *-+: *$/.test(item.align[i])) {
            item.align[i] = "right";
          } else if (/^ *:-+: *$/.test(item.align[i])) {
            item.align[i] = "center";
          } else if (/^ *:-+ *$/.test(item.align[i])) {
            item.align[i] = "left";
          } else {
            item.align[i] = null;
          }
        }
        l = item.rows.length;
        for (i = 0; i < l; i++) {
          item.rows[i] = splitCells(item.rows[i], item.header.length).map((c) => {
            return { text: c };
          });
        }
        l = item.header.length;
        for (j = 0; j < l; j++) {
          item.header[j].tokens = this.lexer.inline(item.header[j].text);
        }
        l = item.rows.length;
        for (j = 0; j < l; j++) {
          row = item.rows[j];
          for (k = 0; k < row.length; k++) {
            row[k].tokens = this.lexer.inline(row[k].text);
          }
        }
        return item;
      }
    }
  }
  lheading(src) {
    const cap = this.rules.block.lheading.exec(src);
    if (cap) {
      return {
        type: "heading",
        raw: cap[0],
        depth: cap[2].charAt(0) === "=" ? 1 : 2,
        text: cap[1],
        tokens: this.lexer.inline(cap[1])
      };
    }
  }
  paragraph(src) {
    const cap = this.rules.block.paragraph.exec(src);
    if (cap) {
      const text = cap[1].charAt(cap[1].length - 1) === "\n" ? cap[1].slice(0, -1) : cap[1];
      return {
        type: "paragraph",
        raw: cap[0],
        text,
        tokens: this.lexer.inline(text)
      };
    }
  }
  text(src) {
    const cap = this.rules.block.text.exec(src);
    if (cap) {
      return {
        type: "text",
        raw: cap[0],
        text: cap[0],
        tokens: this.lexer.inline(cap[0])
      };
    }
  }
  escape(src) {
    const cap = this.rules.inline.escape.exec(src);
    if (cap) {
      return {
        type: "escape",
        raw: cap[0],
        text: escape(cap[1])
      };
    }
  }
  tag(src) {
    const cap = this.rules.inline.tag.exec(src);
    if (cap) {
      if (!this.lexer.state.inLink && /^<a /i.test(cap[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && /^<\/a>/i.test(cap[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(cap[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(cap[0])) {
        this.lexer.state.inRawBlock = false;
      }
      return {
        type: this.options.sanitize ? "text" : "html",
        raw: cap[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        text: this.options.sanitize ? this.options.sanitizer ? this.options.sanitizer(cap[0]) : escape(cap[0]) : cap[0]
      };
    }
  }
  link(src) {
    const cap = this.rules.inline.link.exec(src);
    if (cap) {
      const trimmedUrl = cap[2].trim();
      if (!this.options.pedantic && /^</.test(trimmedUrl)) {
        if (!/>$/.test(trimmedUrl)) {
          return;
        }
        const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), "\\");
        if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
          return;
        }
      } else {
        const lastParenIndex = findClosingBracket(cap[2], "()");
        if (lastParenIndex > -1) {
          const start = cap[0].indexOf("!") === 0 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = cap[0].substring(0, linkLen).trim();
          cap[3] = "";
        }
      }
      let href = cap[2];
      let title = "";
      if (this.options.pedantic) {
        const link = /^([^'"]*[^\s])\s+(['"])(.*)\2/.exec(href);
        if (link) {
          href = link[1];
          title = link[3];
        }
      } else {
        title = cap[3] ? cap[3].slice(1, -1) : "";
      }
      href = href.trim();
      if (/^</.test(href)) {
        if (this.options.pedantic && !/>$/.test(trimmedUrl)) {
          href = href.slice(1);
        } else {
          href = href.slice(1, -1);
        }
      }
      return outputLink(cap, {
        href: href ? href.replace(this.rules.inline._escapes, "$1") : href,
        title: title ? title.replace(this.rules.inline._escapes, "$1") : title
      }, cap[0], this.lexer);
    }
  }
  reflink(src, links) {
    let cap;
    if ((cap = this.rules.inline.reflink.exec(src)) || (cap = this.rules.inline.nolink.exec(src))) {
      let link = (cap[2] || cap[1]).replace(/\s+/g, " ");
      link = links[link.toLowerCase()];
      if (!link) {
        const text = cap[0].charAt(0);
        return {
          type: "text",
          raw: text,
          text
        };
      }
      return outputLink(cap, link, cap[0], this.lexer);
    }
  }
  emStrong(src, maskedSrc, prevChar = "") {
    let match = this.rules.inline.emStrong.lDelim.exec(src);
    if (!match) return;
    if (match[3] && prevChar.match(/[\p{L}\p{N}]/u)) return;
    const nextChar = match[1] || match[2] || "";
    if (!nextChar || nextChar && (prevChar === "" || this.rules.inline.punctuation.exec(prevChar))) {
      const lLength = match[0].length - 1;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
      const endReg = match[0][0] === "*" ? this.rules.inline.emStrong.rDelimAst : this.rules.inline.emStrong.rDelimUnd;
      endReg.lastIndex = 0;
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
      while ((match = endReg.exec(maskedSrc)) != null) {
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!rDelim) continue;
        rLength = rDelim.length;
        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        } else if (match[5] || match[6]) {
          if (lLength % 3 && !((lLength + rLength) % 3)) {
            midDelimTotal += rLength;
            continue;
          }
        }
        delimTotal -= rLength;
        if (delimTotal > 0) continue;
        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        const raw = src.slice(0, lLength + match.index + (match[0].length - rDelim.length) + rLength);
        if (Math.min(lLength, rLength) % 2) {
          const text2 = raw.slice(1, -1);
          return {
            type: "em",
            raw,
            text: text2,
            tokens: this.lexer.inlineTokens(text2)
          };
        }
        const text = raw.slice(2, -2);
        return {
          type: "strong",
          raw,
          text,
          tokens: this.lexer.inlineTokens(text)
        };
      }
    }
  }
  codespan(src) {
    const cap = this.rules.inline.code.exec(src);
    if (cap) {
      let text = cap[2].replace(/\n/g, " ");
      const hasNonSpaceChars = /[^ ]/.test(text);
      const hasSpaceCharsOnBothEnds = /^ /.test(text) && / $/.test(text);
      if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
        text = text.substring(1, text.length - 1);
      }
      text = escape(text, true);
      return {
        type: "codespan",
        raw: cap[0],
        text
      };
    }
  }
  br(src) {
    const cap = this.rules.inline.br.exec(src);
    if (cap) {
      return {
        type: "br",
        raw: cap[0]
      };
    }
  }
  del(src) {
    const cap = this.rules.inline.del.exec(src);
    if (cap) {
      return {
        type: "del",
        raw: cap[0],
        text: cap[2],
        tokens: this.lexer.inlineTokens(cap[2])
      };
    }
  }
  autolink(src, mangle2) {
    const cap = this.rules.inline.autolink.exec(src);
    if (cap) {
      let text, href;
      if (cap[2] === "@") {
        text = escape(this.options.mangle ? mangle2(cap[1]) : cap[1]);
        href = "mailto:" + text;
      } else {
        text = escape(cap[1]);
        href = text;
      }
      return {
        type: "link",
        raw: cap[0],
        text,
        href,
        tokens: [
          {
            type: "text",
            raw: text,
            text
          }
        ]
      };
    }
  }
  url(src, mangle2) {
    let cap;
    if (cap = this.rules.inline.url.exec(src)) {
      let text, href;
      if (cap[2] === "@") {
        text = escape(this.options.mangle ? mangle2(cap[0]) : cap[0]);
        href = "mailto:" + text;
      } else {
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = this.rules.inline._backpedal.exec(cap[0])[0];
        } while (prevCapZero !== cap[0]);
        text = escape(cap[0]);
        if (cap[1] === "www.") {
          href = "http://" + cap[0];
        } else {
          href = cap[0];
        }
      }
      return {
        type: "link",
        raw: cap[0],
        text,
        href,
        tokens: [
          {
            type: "text",
            raw: text,
            text
          }
        ]
      };
    }
  }
  inlineText(src, smartypants2) {
    const cap = this.rules.inline.text.exec(src);
    if (cap) {
      let text;
      if (this.lexer.state.inRawBlock) {
        text = this.options.sanitize ? this.options.sanitizer ? this.options.sanitizer(cap[0]) : escape(cap[0]) : cap[0];
      } else {
        text = escape(this.options.smartypants ? smartypants2(cap[0]) : cap[0]);
      }
      return {
        type: "text",
        raw: cap[0],
        text
      };
    }
  }
};
var block = {
  newline: /^(?: *(?:\n|$))+/,
  code: /^( {4}[^\n]+(?:\n(?: *(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/,
  list: /^( {0,3}bull)([ \t][^\n]+?)?(?:\n|$)/,
  html: "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n *)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n *)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n *)+\\n|$))",
  def: /^ {0,3}\[(label)\]: *(?:\n *)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n *)?| *\n *)(title))? *(?:\n+|$)/,
  table: noopTest,
  lheading: /^((?:.|\n(?!\n))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,
  // regex template, placeholders will be replaced according to different paragraph
  // interruption rules of commonmark and the original markdown spec:
  _paragraph: /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/,
  text: /^[^\n]+/
};
block._label = /(?!\s*\])(?:\\.|[^\[\]\\])+/;
block._title = /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/;
block.def = edit(block.def).replace("label", block._label).replace("title", block._title).getRegex();
block.bullet = /(?:[*+-]|\d{1,9}[.)])/;
block.listItemStart = edit(/^( *)(bull) */).replace("bull", block.bullet).getRegex();
block.list = edit(block.list).replace(/bull/g, block.bullet).replace("hr", "\\n+(?=\\1?(?:(?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$))").replace("def", "\\n+(?=" + block.def.source + ")").getRegex();
block._tag = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
block._comment = /<!--(?!-?>)[\s\S]*?(?:-->|$)/;
block.html = edit(block.html, "i").replace("comment", block._comment).replace("tag", block._tag).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
block.paragraph = edit(block._paragraph).replace("hr", block.hr).replace("heading", " {0,3}#{1,6} ").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", block._tag).getRegex();
block.blockquote = edit(block.blockquote).replace("paragraph", block.paragraph).getRegex();
block.normal = { ...block };
block.gfm = {
  ...block.normal,
  table: "^ *([^\\n ].*\\|.*)\\n {0,3}(?:\\| *)?(:?-+:? *(?:\\| *:?-+:? *)*)(?:\\| *)?(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)"
  // Cells
};
block.gfm.table = edit(block.gfm.table).replace("hr", block.hr).replace("heading", " {0,3}#{1,6} ").replace("blockquote", " {0,3}>").replace("code", " {4}[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", block._tag).getRegex();
block.gfm.paragraph = edit(block._paragraph).replace("hr", block.hr).replace("heading", " {0,3}#{1,6} ").replace("|lheading", "").replace("table", block.gfm.table).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)]) ").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", block._tag).getRegex();
block.pedantic = {
  ...block.normal,
  html: edit(
    `^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`
  ).replace("comment", block._comment).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),
  def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,
  heading: /^(#{1,6})(.*)(?:\n+|$)/,
  fences: noopTest,
  // fences not supported
  lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,
  paragraph: edit(block.normal._paragraph).replace("hr", block.hr).replace("heading", " *#{1,6} *[^\n]").replace("lheading", block.lheading).replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").getRegex()
};
var inline = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  autolink: /^<(scheme:[^\s\x00-\x1f<>]*|email)>/,
  url: noopTest,
  tag: "^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
  // CDATA section
  link: /^!?\[(label)\]\(\s*(href)(?:\s+(title))?\s*\)/,
  reflink: /^!?\[(label)\]\[(ref)\]/,
  nolink: /^!?\[(ref)\](?:\[\])?/,
  reflinkSearch: "reflink|nolink(?!\\()",
  emStrong: {
    lDelim: /^(?:\*+(?:([punct_])|[^\s*]))|^_+(?:([punct*])|([^\s_]))/,
    //        (1) and (2) can only be a Right Delimiter. (3) and (4) can only be Left.  (5) and (6) can be either Left or Right.
    //          () Skip orphan inside strong                                      () Consume to delim     (1) #***                (2) a***#, a***                             (3) #***a, ***a                 (4) ***#              (5) #***#                 (6) a***a
    rDelimAst: /^(?:[^_*\\]|\\.)*?\_\_(?:[^_*\\]|\\.)*?\*(?:[^_*\\]|\\.)*?(?=\_\_)|(?:[^*\\]|\\.)+(?=[^*])|[punct_](\*+)(?=[\s]|$)|(?:[^punct*_\s\\]|\\.)(\*+)(?=[punct_\s]|$)|[punct_\s](\*+)(?=[^punct*_\s])|[\s](\*+)(?=[punct_])|[punct_](\*+)(?=[punct_])|(?:[^punct*_\s\\]|\\.)(\*+)(?=[^punct*_\s])/,
    rDelimUnd: /^(?:[^_*\\]|\\.)*?\*\*(?:[^_*\\]|\\.)*?\_(?:[^_*\\]|\\.)*?(?=\*\*)|(?:[^_\\]|\\.)+(?=[^_])|[punct*](\_+)(?=[\s]|$)|(?:[^punct*_\s\\]|\\.)(\_+)(?=[punct*\s]|$)|[punct*\s](\_+)(?=[^punct*_\s])|[\s](\_+)(?=[punct*])|[punct*](\_+)(?=[punct*])/
    // ^- Not allowed for _
  },
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)/,
  del: noopTest,
  text: /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,
  punctuation: /^([\spunctuation])/
};
inline._punctuation = "!\"#$%&'()+\\-.,/:;<=>?@\\[\\]`^{|}~";
inline.punctuation = edit(inline.punctuation).replace(/punctuation/g, inline._punctuation).getRegex();
inline.blockSkip = /\[[^\]]*?\]\([^\)]*?\)|`[^`]*?`|<[^>]*?>/g;
inline.escapedEmSt = /(?:^|[^\\])(?:\\\\)*\\[*_]/g;
inline._comment = edit(block._comment).replace("(?:-->|$)", "-->").getRegex();
inline.emStrong.lDelim = edit(inline.emStrong.lDelim).replace(/punct/g, inline._punctuation).getRegex();
inline.emStrong.rDelimAst = edit(inline.emStrong.rDelimAst, "g").replace(/punct/g, inline._punctuation).getRegex();
inline.emStrong.rDelimUnd = edit(inline.emStrong.rDelimUnd, "g").replace(/punct/g, inline._punctuation).getRegex();
inline._escapes = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;
inline._scheme = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
inline._email = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
inline.autolink = edit(inline.autolink).replace("scheme", inline._scheme).replace("email", inline._email).getRegex();
inline._attribute = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;
inline.tag = edit(inline.tag).replace("comment", inline._comment).replace("attribute", inline._attribute).getRegex();
inline._label = /(?:\[(?:\\.|[^\[\]\\])*\]|\\.|`[^`]*`|[^\[\]\\`])*?/;
inline._href = /<(?:\\.|[^\n<>\\])+>|[^\s\x00-\x1f]*/;
inline._title = /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/;
inline.link = edit(inline.link).replace("label", inline._label).replace("href", inline._href).replace("title", inline._title).getRegex();
inline.reflink = edit(inline.reflink).replace("label", inline._label).replace("ref", block._label).getRegex();
inline.nolink = edit(inline.nolink).replace("ref", block._label).getRegex();
inline.reflinkSearch = edit(inline.reflinkSearch, "g").replace("reflink", inline.reflink).replace("nolink", inline.nolink).getRegex();
inline.normal = { ...inline };
inline.pedantic = {
  ...inline.normal,
  strong: {
    start: /^__|\*\*/,
    middle: /^__(?=\S)([\s\S]*?\S)__(?!_)|^\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/,
    endAst: /\*\*(?!\*)/g,
    endUnd: /__(?!_)/g
  },
  em: {
    start: /^_|\*/,
    middle: /^()\*(?=\S)([\s\S]*?\S)\*(?!\*)|^_(?=\S)([\s\S]*?\S)_(?!_)/,
    endAst: /\*(?!\*)/g,
    endUnd: /_(?!_)/g
  },
  link: edit(/^!?\[(label)\]\((.*?)\)/).replace("label", inline._label).getRegex(),
  reflink: edit(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", inline._label).getRegex()
};
inline.gfm = {
  ...inline.normal,
  escape: edit(inline.escape).replace("])", "~|])").getRegex(),
  _extended_email: /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/,
  url: /^((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  del: /^(~~?)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/,
  text: /^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|https?:\/\/|ftp:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/
};
inline.gfm.url = edit(inline.gfm.url, "i").replace("email", inline.gfm._extended_email).getRegex();
inline.breaks = {
  ...inline.gfm,
  br: edit(inline.br).replace("{2,}", "*").getRegex(),
  text: edit(inline.gfm.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex()
};
function smartypants(text) {
  return text.replace(/---/g, "\u2014").replace(/--/g, "\u2013").replace(/(^|[-\u2014/(\[{"\s])'/g, "$1\u2018").replace(/'/g, "\u2019").replace(/(^|[-\u2014/(\[{\u2018\s])"/g, "$1\u201C").replace(/"/g, "\u201D").replace(/\.{3}/g, "\u2026");
}
function mangle(text) {
  let out = "", i, ch;
  const l = text.length;
  for (i = 0; i < l; i++) {
    ch = text.charCodeAt(i);
    if (Math.random() > 0.5) {
      ch = "x" + ch.toString(16);
    }
    out += "&#" + ch + ";";
  }
  return out;
}
var Lexer = class _Lexer {
  constructor(options2) {
    this.tokens = [];
    this.tokens.links = /* @__PURE__ */ Object.create(null);
    this.options = options2 || defaults;
    this.options.tokenizer = this.options.tokenizer || new Tokenizer();
    this.tokenizer = this.options.tokenizer;
    this.tokenizer.options = this.options;
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      top: true
    };
    const rules = {
      block: block.normal,
      inline: inline.normal
    };
    if (this.options.pedantic) {
      rules.block = block.pedantic;
      rules.inline = inline.pedantic;
    } else if (this.options.gfm) {
      rules.block = block.gfm;
      if (this.options.breaks) {
        rules.inline = inline.breaks;
      } else {
        rules.inline = inline.gfm;
      }
    }
    this.tokenizer.rules = rules;
  }
  /**
   * Expose Rules
   */
  static get rules() {
    return {
      block,
      inline
    };
  }
  /**
   * Static Lex Method
   */
  static lex(src, options2) {
    const lexer2 = new _Lexer(options2);
    return lexer2.lex(src);
  }
  /**
   * Static Lex Inline Method
   */
  static lexInline(src, options2) {
    const lexer2 = new _Lexer(options2);
    return lexer2.inlineTokens(src);
  }
  /**
   * Preprocessing
   */
  lex(src) {
    src = src.replace(/\r\n|\r/g, "\n");
    this.blockTokens(src, this.tokens);
    let next;
    while (next = this.inlineQueue.shift()) {
      this.inlineTokens(next.src, next.tokens);
    }
    return this.tokens;
  }
  /**
   * Lexing
   */
  blockTokens(src, tokens = []) {
    if (this.options.pedantic) {
      src = src.replace(/\t/g, "    ").replace(/^ +$/gm, "");
    } else {
      src = src.replace(/^( *)(\t+)/gm, (_, leading, tabs) => {
        return leading + "    ".repeat(tabs.length);
      });
    }
    let token, lastToken, cutSrc, lastParagraphClipped;
    while (src) {
      if (this.options.extensions && this.options.extensions.block && this.options.extensions.block.some((extTokenizer) => {
        if (token = extTokenizer.call({ lexer: this }, src, tokens)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          return true;
        }
        return false;
      })) {
        continue;
      }
      if (token = this.tokenizer.space(src)) {
        src = src.substring(token.raw.length);
        if (token.raw.length === 1 && tokens.length > 0) {
          tokens[tokens.length - 1].raw += "\n";
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (token = this.tokenizer.code(src)) {
        src = src.substring(token.raw.length);
        lastToken = tokens[tokens.length - 1];
        if (lastToken && (lastToken.type === "paragraph" || lastToken.type === "text")) {
          lastToken.raw += "\n" + token.raw;
          lastToken.text += "\n" + token.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (token = this.tokenizer.fences(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.heading(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.hr(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.blockquote(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.list(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.html(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.def(src)) {
        src = src.substring(token.raw.length);
        lastToken = tokens[tokens.length - 1];
        if (lastToken && (lastToken.type === "paragraph" || lastToken.type === "text")) {
          lastToken.raw += "\n" + token.raw;
          lastToken.text += "\n" + token.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = lastToken.text;
        } else if (!this.tokens.links[token.tag]) {
          this.tokens.links[token.tag] = {
            href: token.href,
            title: token.title
          };
        }
        continue;
      }
      if (token = this.tokenizer.table(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.lheading(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      cutSrc = src;
      if (this.options.extensions && this.options.extensions.startBlock) {
        let startIndex = Infinity;
        const tempSrc = src.slice(1);
        let tempStart;
        this.options.extensions.startBlock.forEach(function(getStartIndex) {
          tempStart = getStartIndex.call({ lexer: this }, tempSrc);
          if (typeof tempStart === "number" && tempStart >= 0) {
            startIndex = Math.min(startIndex, tempStart);
          }
        });
        if (startIndex < Infinity && startIndex >= 0) {
          cutSrc = src.substring(0, startIndex + 1);
        }
      }
      if (this.state.top && (token = this.tokenizer.paragraph(cutSrc))) {
        lastToken = tokens[tokens.length - 1];
        if (lastParagraphClipped && lastToken.type === "paragraph") {
          lastToken.raw += "\n" + token.raw;
          lastToken.text += "\n" + token.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = cutSrc.length !== src.length;
        src = src.substring(token.raw.length);
        continue;
      }
      if (token = this.tokenizer.text(src)) {
        src = src.substring(token.raw.length);
        lastToken = tokens[tokens.length - 1];
        if (lastToken && lastToken.type === "text") {
          lastToken.raw += "\n" + token.raw;
          lastToken.text += "\n" + token.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (src) {
        const errMsg = "Infinite loop on byte: " + src.charCodeAt(0);
        if (this.options.silent) {
          console.error(errMsg);
          break;
        } else {
          throw new Error(errMsg);
        }
      }
    }
    this.state.top = true;
    return tokens;
  }
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }
  /**
   * Lexing/Compiling
   */
  inlineTokens(src, tokens = []) {
    let token, lastToken, cutSrc;
    let maskedSrc = src;
    let match;
    let keepPrevChar, prevChar;
    if (this.tokens.links) {
      const links = Object.keys(this.tokens.links);
      if (links.length > 0) {
        while ((match = this.tokenizer.rules.inline.reflinkSearch.exec(maskedSrc)) != null) {
          if (links.includes(match[0].slice(match[0].lastIndexOf("[") + 1, -1))) {
            maskedSrc = maskedSrc.slice(0, match.index) + "[" + repeatString("a", match[0].length - 2) + "]" + maskedSrc.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex);
          }
        }
      }
    }
    while ((match = this.tokenizer.rules.inline.blockSkip.exec(maskedSrc)) != null) {
      maskedSrc = maskedSrc.slice(0, match.index) + "[" + repeatString("a", match[0].length - 2) + "]" + maskedSrc.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
    }
    while ((match = this.tokenizer.rules.inline.escapedEmSt.exec(maskedSrc)) != null) {
      maskedSrc = maskedSrc.slice(0, match.index + match[0].length - 2) + "++" + maskedSrc.slice(this.tokenizer.rules.inline.escapedEmSt.lastIndex);
      this.tokenizer.rules.inline.escapedEmSt.lastIndex--;
    }
    while (src) {
      if (!keepPrevChar) {
        prevChar = "";
      }
      keepPrevChar = false;
      if (this.options.extensions && this.options.extensions.inline && this.options.extensions.inline.some((extTokenizer) => {
        if (token = extTokenizer.call({ lexer: this }, src, tokens)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          return true;
        }
        return false;
      })) {
        continue;
      }
      if (token = this.tokenizer.escape(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.tag(src)) {
        src = src.substring(token.raw.length);
        lastToken = tokens[tokens.length - 1];
        if (lastToken && token.type === "text" && lastToken.type === "text") {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (token = this.tokenizer.link(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.reflink(src, this.tokens.links)) {
        src = src.substring(token.raw.length);
        lastToken = tokens[tokens.length - 1];
        if (lastToken && token.type === "text" && lastToken.type === "text") {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (token = this.tokenizer.emStrong(src, maskedSrc, prevChar)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.codespan(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.br(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.del(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.autolink(src, mangle)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (!this.state.inLink && (token = this.tokenizer.url(src, mangle))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      cutSrc = src;
      if (this.options.extensions && this.options.extensions.startInline) {
        let startIndex = Infinity;
        const tempSrc = src.slice(1);
        let tempStart;
        this.options.extensions.startInline.forEach(function(getStartIndex) {
          tempStart = getStartIndex.call({ lexer: this }, tempSrc);
          if (typeof tempStart === "number" && tempStart >= 0) {
            startIndex = Math.min(startIndex, tempStart);
          }
        });
        if (startIndex < Infinity && startIndex >= 0) {
          cutSrc = src.substring(0, startIndex + 1);
        }
      }
      if (token = this.tokenizer.inlineText(cutSrc, smartypants)) {
        src = src.substring(token.raw.length);
        if (token.raw.slice(-1) !== "_") {
          prevChar = token.raw.slice(-1);
        }
        keepPrevChar = true;
        lastToken = tokens[tokens.length - 1];
        if (lastToken && lastToken.type === "text") {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (src) {
        const errMsg = "Infinite loop on byte: " + src.charCodeAt(0);
        if (this.options.silent) {
          console.error(errMsg);
          break;
        } else {
          throw new Error(errMsg);
        }
      }
    }
    return tokens;
  }
};
var Renderer = class {
  constructor(options2) {
    this.options = options2 || defaults;
  }
  code(code, infostring, escaped) {
    const lang = (infostring || "").match(/\S*/)[0];
    if (this.options.highlight) {
      const out = this.options.highlight(code, lang);
      if (out != null && out !== code) {
        escaped = true;
        code = out;
      }
    }
    code = code.replace(/\n$/, "") + "\n";
    if (!lang) {
      return "<pre><code>" + (escaped ? code : escape(code, true)) + "</code></pre>\n";
    }
    return '<pre><code class="' + this.options.langPrefix + escape(lang) + '">' + (escaped ? code : escape(code, true)) + "</code></pre>\n";
  }
  /**
   * @param {string} quote
   */
  blockquote(quote) {
    return `<blockquote>
${quote}</blockquote>
`;
  }
  html(html) {
    return html;
  }
  /**
   * @param {string} text
   * @param {string} level
   * @param {string} raw
   * @param {any} slugger
   */
  heading(text, level, raw, slugger) {
    if (this.options.headerIds) {
      const id = this.options.headerPrefix + slugger.slug(raw);
      return `<h${level} id="${id}">${text}</h${level}>
`;
    }
    return `<h${level}>${text}</h${level}>
`;
  }
  hr() {
    return this.options.xhtml ? "<hr/>\n" : "<hr>\n";
  }
  list(body, ordered, start) {
    const type = ordered ? "ol" : "ul", startatt = ordered && start !== 1 ? ' start="' + start + '"' : "";
    return "<" + type + startatt + ">\n" + body + "</" + type + ">\n";
  }
  /**
   * @param {string} text
   */
  listitem(text) {
    return `<li>${text}</li>
`;
  }
  checkbox(checked) {
    return "<input " + (checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"' + (this.options.xhtml ? " /" : "") + "> ";
  }
  /**
   * @param {string} text
   */
  paragraph(text) {
    return `<p>${text}</p>
`;
  }
  /**
   * @param {string} header
   * @param {string} body
   */
  table(header, body) {
    if (body) body = `<tbody>${body}</tbody>`;
    return "<table>\n<thead>\n" + header + "</thead>\n" + body + "</table>\n";
  }
  /**
   * @param {string} content
   */
  tablerow(content) {
    return `<tr>
${content}</tr>
`;
  }
  tablecell(content, flags) {
    const type = flags.header ? "th" : "td";
    const tag = flags.align ? `<${type} align="${flags.align}">` : `<${type}>`;
    return tag + content + `</${type}>
`;
  }
  /**
   * span level renderer
   * @param {string} text
   */
  strong(text) {
    return `<strong>${text}</strong>`;
  }
  /**
   * @param {string} text
   */
  em(text) {
    return `<em>${text}</em>`;
  }
  /**
   * @param {string} text
   */
  codespan(text) {
    return `<code>${text}</code>`;
  }
  br() {
    return this.options.xhtml ? "<br/>" : "<br>";
  }
  /**
   * @param {string} text
   */
  del(text) {
    return `<del>${text}</del>`;
  }
  /**
   * @param {string} href
   * @param {string} title
   * @param {string} text
   */
  link(href, title, text) {
    href = cleanUrl(this.options.sanitize, this.options.baseUrl, href);
    if (href === null) {
      return text;
    }
    let out = '<a href="' + href + '"';
    if (title) {
      out += ' title="' + title + '"';
    }
    out += ">" + text + "</a>";
    return out;
  }
  /**
   * @param {string} href
   * @param {string} title
   * @param {string} text
   */
  image(href, title, text) {
    href = cleanUrl(this.options.sanitize, this.options.baseUrl, href);
    if (href === null) {
      return text;
    }
    let out = `<img src="${href}" alt="${text}"`;
    if (title) {
      out += ` title="${title}"`;
    }
    out += this.options.xhtml ? "/>" : ">";
    return out;
  }
  text(text) {
    return text;
  }
};
var TextRenderer = class {
  // no need for block level renderers
  strong(text) {
    return text;
  }
  em(text) {
    return text;
  }
  codespan(text) {
    return text;
  }
  del(text) {
    return text;
  }
  html(text) {
    return text;
  }
  text(text) {
    return text;
  }
  link(href, title, text) {
    return "" + text;
  }
  image(href, title, text) {
    return "" + text;
  }
  br() {
    return "";
  }
};
var Slugger = class {
  constructor() {
    this.seen = {};
  }
  /**
   * @param {string} value
   */
  serialize(value) {
    return value.toLowerCase().trim().replace(/<[!\/a-z].*?>/ig, "").replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "").replace(/\s/g, "-");
  }
  /**
   * Finds the next safe (unique) slug to use
   * @param {string} originalSlug
   * @param {boolean} isDryRun
   */
  getNextSafeSlug(originalSlug, isDryRun) {
    let slug = originalSlug;
    let occurenceAccumulator = 0;
    if (this.seen.hasOwnProperty(slug)) {
      occurenceAccumulator = this.seen[originalSlug];
      do {
        occurenceAccumulator++;
        slug = originalSlug + "-" + occurenceAccumulator;
      } while (this.seen.hasOwnProperty(slug));
    }
    if (!isDryRun) {
      this.seen[originalSlug] = occurenceAccumulator;
      this.seen[slug] = 0;
    }
    return slug;
  }
  /**
   * Convert string to unique id
   * @param {object} [options]
   * @param {boolean} [options.dryrun] Generates the next unique slug without
   * updating the internal accumulator.
   */
  slug(value, options2 = {}) {
    const slug = this.serialize(value);
    return this.getNextSafeSlug(slug, options2.dryrun);
  }
};
var Parser = class _Parser {
  constructor(options2) {
    this.options = options2 || defaults;
    this.options.renderer = this.options.renderer || new Renderer();
    this.renderer = this.options.renderer;
    this.renderer.options = this.options;
    this.textRenderer = new TextRenderer();
    this.slugger = new Slugger();
  }
  /**
   * Static Parse Method
   */
  static parse(tokens, options2) {
    const parser2 = new _Parser(options2);
    return parser2.parse(tokens);
  }
  /**
   * Static Parse Inline Method
   */
  static parseInline(tokens, options2) {
    const parser2 = new _Parser(options2);
    return parser2.parseInline(tokens);
  }
  /**
   * Parse Loop
   */
  parse(tokens, top = true) {
    let out = "", i, j, k, l2, l3, row, cell, header, body, token, ordered, start, loose, itemBody, item, checked, task, checkbox, ret;
    const l = tokens.length;
    for (i = 0; i < l; i++) {
      token = tokens[i];
      if (this.options.extensions && this.options.extensions.renderers && this.options.extensions.renderers[token.type]) {
        ret = this.options.extensions.renderers[token.type].call({ parser: this }, token);
        if (ret !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "paragraph", "text"].includes(token.type)) {
          out += ret || "";
          continue;
        }
      }
      switch (token.type) {
        case "space": {
          continue;
        }
        case "hr": {
          out += this.renderer.hr();
          continue;
        }
        case "heading": {
          out += this.renderer.heading(
            this.parseInline(token.tokens),
            token.depth,
            unescape(this.parseInline(token.tokens, this.textRenderer)),
            this.slugger
          );
          continue;
        }
        case "code": {
          out += this.renderer.code(
            token.text,
            token.lang,
            token.escaped
          );
          continue;
        }
        case "table": {
          header = "";
          cell = "";
          l2 = token.header.length;
          for (j = 0; j < l2; j++) {
            cell += this.renderer.tablecell(
              this.parseInline(token.header[j].tokens),
              { header: true, align: token.align[j] }
            );
          }
          header += this.renderer.tablerow(cell);
          body = "";
          l2 = token.rows.length;
          for (j = 0; j < l2; j++) {
            row = token.rows[j];
            cell = "";
            l3 = row.length;
            for (k = 0; k < l3; k++) {
              cell += this.renderer.tablecell(
                this.parseInline(row[k].tokens),
                { header: false, align: token.align[k] }
              );
            }
            body += this.renderer.tablerow(cell);
          }
          out += this.renderer.table(header, body);
          continue;
        }
        case "blockquote": {
          body = this.parse(token.tokens);
          out += this.renderer.blockquote(body);
          continue;
        }
        case "list": {
          ordered = token.ordered;
          start = token.start;
          loose = token.loose;
          l2 = token.items.length;
          body = "";
          for (j = 0; j < l2; j++) {
            item = token.items[j];
            checked = item.checked;
            task = item.task;
            itemBody = "";
            if (item.task) {
              checkbox = this.renderer.checkbox(checked);
              if (loose) {
                if (item.tokens.length > 0 && item.tokens[0].type === "paragraph") {
                  item.tokens[0].text = checkbox + " " + item.tokens[0].text;
                  if (item.tokens[0].tokens && item.tokens[0].tokens.length > 0 && item.tokens[0].tokens[0].type === "text") {
                    item.tokens[0].tokens[0].text = checkbox + " " + item.tokens[0].tokens[0].text;
                  }
                } else {
                  item.tokens.unshift({
                    type: "text",
                    text: checkbox
                  });
                }
              } else {
                itemBody += checkbox;
              }
            }
            itemBody += this.parse(item.tokens, loose);
            body += this.renderer.listitem(itemBody, task, checked);
          }
          out += this.renderer.list(body, ordered, start);
          continue;
        }
        case "html": {
          out += this.renderer.html(token.text);
          continue;
        }
        case "paragraph": {
          out += this.renderer.paragraph(this.parseInline(token.tokens));
          continue;
        }
        case "text": {
          body = token.tokens ? this.parseInline(token.tokens) : token.text;
          while (i + 1 < l && tokens[i + 1].type === "text") {
            token = tokens[++i];
            body += "\n" + (token.tokens ? this.parseInline(token.tokens) : token.text);
          }
          out += top ? this.renderer.paragraph(body) : body;
          continue;
        }
        default: {
          const errMsg = 'Token with "' + token.type + '" type was not found.';
          if (this.options.silent) {
            console.error(errMsg);
            return;
          } else {
            throw new Error(errMsg);
          }
        }
      }
    }
    return out;
  }
  /**
   * Parse Inline Tokens
   */
  parseInline(tokens, renderer) {
    renderer = renderer || this.renderer;
    let out = "", i, token, ret;
    const l = tokens.length;
    for (i = 0; i < l; i++) {
      token = tokens[i];
      if (this.options.extensions && this.options.extensions.renderers && this.options.extensions.renderers[token.type]) {
        ret = this.options.extensions.renderers[token.type].call({ parser: this }, token);
        if (ret !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(token.type)) {
          out += ret || "";
          continue;
        }
      }
      switch (token.type) {
        case "escape": {
          out += renderer.text(token.text);
          break;
        }
        case "html": {
          out += renderer.html(token.text);
          break;
        }
        case "link": {
          out += renderer.link(token.href, token.title, this.parseInline(token.tokens, renderer));
          break;
        }
        case "image": {
          out += renderer.image(token.href, token.title, token.text);
          break;
        }
        case "strong": {
          out += renderer.strong(this.parseInline(token.tokens, renderer));
          break;
        }
        case "em": {
          out += renderer.em(this.parseInline(token.tokens, renderer));
          break;
        }
        case "codespan": {
          out += renderer.codespan(token.text);
          break;
        }
        case "br": {
          out += renderer.br();
          break;
        }
        case "del": {
          out += renderer.del(this.parseInline(token.tokens, renderer));
          break;
        }
        case "text": {
          out += renderer.text(token.text);
          break;
        }
        default: {
          const errMsg = 'Token with "' + token.type + '" type was not found.';
          if (this.options.silent) {
            console.error(errMsg);
            return;
          } else {
            throw new Error(errMsg);
          }
        }
      }
    }
    return out;
  }
};
var Hooks = class {
  constructor(options2) {
    this.options = options2 || defaults;
  }
  static passThroughHooks = /* @__PURE__ */ new Set([
    "preprocess",
    "postprocess"
  ]);
  /**
   * Process markdown before marked
   */
  preprocess(markdown) {
    return markdown;
  }
  /**
   * Process HTML after marked is finished
   */
  postprocess(html) {
    return html;
  }
};
function onError(silent, async, callback) {
  return (e) => {
    e.message += "\nPlease report this to https://github.com/markedjs/marked.";
    if (silent) {
      const msg = "<p>An error occurred:</p><pre>" + escape(e.message + "", true) + "</pre>";
      if (async) {
        return Promise.resolve(msg);
      }
      if (callback) {
        callback(null, msg);
        return;
      }
      return msg;
    }
    if (async) {
      return Promise.reject(e);
    }
    if (callback) {
      callback(e);
      return;
    }
    throw e;
  };
}
function parseMarkdown(lexer2, parser2) {
  return (src, opt, callback) => {
    if (typeof opt === "function") {
      callback = opt;
      opt = null;
    }
    const origOpt = { ...opt };
    opt = { ...marked.defaults, ...origOpt };
    const throwError = onError(opt.silent, opt.async, callback);
    if (typeof src === "undefined" || src === null) {
      return throwError(new Error("marked(): input parameter is undefined or null"));
    }
    if (typeof src !== "string") {
      return throwError(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(src) + ", string expected"));
    }
    checkSanitizeDeprecation(opt);
    if (opt.hooks) {
      opt.hooks.options = opt;
    }
    if (callback) {
      const highlight = opt.highlight;
      let tokens;
      try {
        if (opt.hooks) {
          src = opt.hooks.preprocess(src);
        }
        tokens = lexer2(src, opt);
      } catch (e) {
        return throwError(e);
      }
      const done = function(err) {
        let out;
        if (!err) {
          try {
            if (opt.walkTokens) {
              marked.walkTokens(tokens, opt.walkTokens);
            }
            out = parser2(tokens, opt);
            if (opt.hooks) {
              out = opt.hooks.postprocess(out);
            }
          } catch (e) {
            err = e;
          }
        }
        opt.highlight = highlight;
        return err ? throwError(err) : callback(null, out);
      };
      if (!highlight || highlight.length < 3) {
        return done();
      }
      delete opt.highlight;
      if (!tokens.length) return done();
      let pending = 0;
      marked.walkTokens(tokens, function(token) {
        if (token.type === "code") {
          pending++;
          setTimeout(() => {
            highlight(token.text, token.lang, function(err, code) {
              if (err) {
                return done(err);
              }
              if (code != null && code !== token.text) {
                token.text = code;
                token.escaped = true;
              }
              pending--;
              if (pending === 0) {
                done();
              }
            });
          }, 0);
        }
      });
      if (pending === 0) {
        done();
      }
      return;
    }
    if (opt.async) {
      return Promise.resolve(opt.hooks ? opt.hooks.preprocess(src) : src).then((src2) => lexer2(src2, opt)).then((tokens) => opt.walkTokens ? Promise.all(marked.walkTokens(tokens, opt.walkTokens)).then(() => tokens) : tokens).then((tokens) => parser2(tokens, opt)).then((html) => opt.hooks ? opt.hooks.postprocess(html) : html).catch(throwError);
    }
    try {
      if (opt.hooks) {
        src = opt.hooks.preprocess(src);
      }
      const tokens = lexer2(src, opt);
      if (opt.walkTokens) {
        marked.walkTokens(tokens, opt.walkTokens);
      }
      let html = parser2(tokens, opt);
      if (opt.hooks) {
        html = opt.hooks.postprocess(html);
      }
      return html;
    } catch (e) {
      return throwError(e);
    }
  };
}
function marked(src, opt, callback) {
  return parseMarkdown(Lexer.lex, Parser.parse)(src, opt, callback);
}
marked.options = marked.setOptions = function(opt) {
  marked.defaults = { ...marked.defaults, ...opt };
  changeDefaults(marked.defaults);
  return marked;
};
marked.getDefaults = getDefaults;
marked.defaults = defaults;
marked.use = function(...args) {
  const extensions = marked.defaults.extensions || { renderers: {}, childTokens: {} };
  args.forEach((pack) => {
    const opts = { ...pack };
    opts.async = marked.defaults.async || opts.async || false;
    if (pack.extensions) {
      pack.extensions.forEach((ext) => {
        if (!ext.name) {
          throw new Error("extension name required");
        }
        if (ext.renderer) {
          const prevRenderer = extensions.renderers[ext.name];
          if (prevRenderer) {
            extensions.renderers[ext.name] = function(...args2) {
              let ret = ext.renderer.apply(this, args2);
              if (ret === false) {
                ret = prevRenderer.apply(this, args2);
              }
              return ret;
            };
          } else {
            extensions.renderers[ext.name] = ext.renderer;
          }
        }
        if (ext.tokenizer) {
          if (!ext.level || ext.level !== "block" && ext.level !== "inline") {
            throw new Error("extension level must be 'block' or 'inline'");
          }
          if (extensions[ext.level]) {
            extensions[ext.level].unshift(ext.tokenizer);
          } else {
            extensions[ext.level] = [ext.tokenizer];
          }
          if (ext.start) {
            if (ext.level === "block") {
              if (extensions.startBlock) {
                extensions.startBlock.push(ext.start);
              } else {
                extensions.startBlock = [ext.start];
              }
            } else if (ext.level === "inline") {
              if (extensions.startInline) {
                extensions.startInline.push(ext.start);
              } else {
                extensions.startInline = [ext.start];
              }
            }
          }
        }
        if (ext.childTokens) {
          extensions.childTokens[ext.name] = ext.childTokens;
        }
      });
      opts.extensions = extensions;
    }
    if (pack.renderer) {
      const renderer = marked.defaults.renderer || new Renderer();
      for (const prop in pack.renderer) {
        const prevRenderer = renderer[prop];
        renderer[prop] = (...args2) => {
          let ret = pack.renderer[prop].apply(renderer, args2);
          if (ret === false) {
            ret = prevRenderer.apply(renderer, args2);
          }
          return ret;
        };
      }
      opts.renderer = renderer;
    }
    if (pack.tokenizer) {
      const tokenizer = marked.defaults.tokenizer || new Tokenizer();
      for (const prop in pack.tokenizer) {
        const prevTokenizer = tokenizer[prop];
        tokenizer[prop] = (...args2) => {
          let ret = pack.tokenizer[prop].apply(tokenizer, args2);
          if (ret === false) {
            ret = prevTokenizer.apply(tokenizer, args2);
          }
          return ret;
        };
      }
      opts.tokenizer = tokenizer;
    }
    if (pack.hooks) {
      const hooks = marked.defaults.hooks || new Hooks();
      for (const prop in pack.hooks) {
        const prevHook = hooks[prop];
        if (Hooks.passThroughHooks.has(prop)) {
          hooks[prop] = (arg) => {
            if (marked.defaults.async) {
              return Promise.resolve(pack.hooks[prop].call(hooks, arg)).then((ret2) => {
                return prevHook.call(hooks, ret2);
              });
            }
            const ret = pack.hooks[prop].call(hooks, arg);
            return prevHook.call(hooks, ret);
          };
        } else {
          hooks[prop] = (...args2) => {
            let ret = pack.hooks[prop].apply(hooks, args2);
            if (ret === false) {
              ret = prevHook.apply(hooks, args2);
            }
            return ret;
          };
        }
      }
      opts.hooks = hooks;
    }
    if (pack.walkTokens) {
      const walkTokens2 = marked.defaults.walkTokens;
      opts.walkTokens = function(token) {
        let values = [];
        values.push(pack.walkTokens.call(this, token));
        if (walkTokens2) {
          values = values.concat(walkTokens2.call(this, token));
        }
        return values;
      };
    }
    marked.setOptions(opts);
  });
};
marked.walkTokens = function(tokens, callback) {
  let values = [];
  for (const token of tokens) {
    values = values.concat(callback.call(marked, token));
    switch (token.type) {
      case "table": {
        for (const cell of token.header) {
          values = values.concat(marked.walkTokens(cell.tokens, callback));
        }
        for (const row of token.rows) {
          for (const cell of row) {
            values = values.concat(marked.walkTokens(cell.tokens, callback));
          }
        }
        break;
      }
      case "list": {
        values = values.concat(marked.walkTokens(token.items, callback));
        break;
      }
      default: {
        if (marked.defaults.extensions && marked.defaults.extensions.childTokens && marked.defaults.extensions.childTokens[token.type]) {
          marked.defaults.extensions.childTokens[token.type].forEach(function(childTokens) {
            values = values.concat(marked.walkTokens(token[childTokens], callback));
          });
        } else if (token.tokens) {
          values = values.concat(marked.walkTokens(token.tokens, callback));
        }
      }
    }
  }
  return values;
};
marked.parseInline = parseMarkdown(Lexer.lexInline, Parser.parseInline);
marked.Parser = Parser;
marked.parser = Parser.parse;
marked.Renderer = Renderer;
marked.TextRenderer = TextRenderer;
marked.Lexer = Lexer;
marked.lexer = Lexer.lex;
marked.Tokenizer = Tokenizer;
marked.Slugger = Slugger;
marked.Hooks = Hooks;
marked.parse = marked;
var options = marked.options;
var setOptions = marked.setOptions;
var use = marked.use;
var walkTokens = marked.walkTokens;
var parseInline = marked.parseInline;
var parser = Parser.parse;
var lexer = Lexer.lex;


var ARC_IDENTITY = {
  productName: "Arc",
  repositoryName: "arc",
  publisher: "glin",
  extensionName: "arc",
  extensionId: "glin.arc",
  commandPrefix: "arc",
  settingsSection: "arc",
  panelType: "arc.panel",
  panelStateKey: "arc.panelState",
  homeDirectory: ".arc",
  snapshotsDirectory: "snapshots",
  environmentPrefix: "ARC_",
  visualizationScheme: "arc-visualization:",
  cliPackageName: "arc-agent-status",
  cliExecutable: "arc-status",
  vsixFileName: "arc.vsix",
  baselineScheme: "arc-baseline",
  patchScheme: "arc-patch"
};


var VISUALIZATION_SCHEME = ARC_IDENTITY.visualizationScheme;


var BEDROCK_272K_ROUTES = {
  prefixes: /^(?:global|[a-z]{2})?$/,
  regionalMultiplier: 1.1,
  window: 272e3,
  cacheLifetime: "30m"
};
var MODELS = [
  {
    pattern: /^claude-(fable|mythos)-5-1(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, cacheRead: 0.25, output: 50 },
    window: 1e6
  },
  {
    pattern: /^claude-(fable|mythos)-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 10, output: 50 },
    window: 1e6
  },
  // https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing
  // Fast mode is sold on the first-party Claude API. A Claude row matches only a turn that
  // names no provider. A Bedrock Claude request names none either, so a fast one pays these
  // rates with the regional Bedrock charge on top.
  {
    pattern: /^claude-opus-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 4, cacheRead: 0.2, output: 20 },
    fast: { input: 8, cacheRead: 0.4, output: 40 },
    window: 1e6
  },
  {
    pattern: /^claude-opus-(5|4-8)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    fast: { input: 10, output: 50 },
    window: 1e6
  },
  // Opus 4.7 refuses a fast request, and Opus 4.6 runs it at standard speed and records that.
  {
    pattern: /^claude-opus-(4-7|4-6)(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 5, output: 25 },
    window: 1e6
  },
  { pattern: /^claude-opus-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 5, output: 25 }, window: 2e5 },
  // Sonnet 5 and Sonnet 5.5 are priced apart from Sonnet 4.6 because their standing rates differ.
  // Sonnet 5.5 has an exact row, so an unpublished later Sonnet stays unpriced.
  { pattern: /^claude-sonnet-5-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 2, output: 10 }, window: 1e6 },
  {
    pattern: /^claude-sonnet-5(?:-\d{8})?(?:\[[^\]]+\])?$/,
    rate: { input: 2, output: 10 },
    window: 1e6,
    effectiveDate: "2026-08-10"
  },
  { pattern: /^claude-sonnet-4-6(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 3, output: 15 }, window: 1e6 },
  { pattern: /^claude-sonnet-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 3, output: 15 }, window: 2e5 },
  { pattern: /^claude-haiku-4-5(?:-\d{8})?(?:\[[^\]]+\])?$/, rate: { input: 1, output: 5 }, window: 2e5 },
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  {
    pattern: /^gpt-6-astra$/,
    rate: { input: 10, cacheWrite30m: 12.5, cacheRead: 1, output: 50 },
    window: 105e4,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  {
    pattern: /^gpt-6\.1-sol$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.1, output: 10 },
    window: 105e4,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 },
    serviceTierMultipliers: { fast: 2, priority: 2, flex: 0.5, batch: 0.5 },
    // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html
    // Cache prices apply to recorded tokens. Explicit prompt caching is unsupported.
    // No fallback lifetime is documented.
    bedrock: {
      prefixes: /^(?:us|global)?$/,
      regionalMultiplier: 1.1,
      window: 1e6,
      effectiveDate: "2026-09-29"
    }
  },
  // https://developers.openai.com/api/docs/models/gpt-6-sol
  {
    pattern: /^gpt-6-sol$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 10 },
    window: 105e4,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 },
    // https://aws.amazon.com/about-aws/whats-new/2026/09/openai-gpt-6-sol-luna-on-amazon-bedrock/
    bedrock: { ...BEDROCK_272K_ROUTES, effectiveDate: "2026-09-22" }
  },
  // https://developers.openai.com/api/docs/models/gpt-6-luna
  {
    pattern: /^gpt-6-luna$/,
    rate: { input: 0.1, cacheWrite30m: 0.125, cacheRead: 0.01, output: 0.5 },
    window: 105e4,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 },
    // https://aws.amazon.com/about-aws/whats-new/2026/09/openai-gpt-6-sol-luna-on-amazon-bedrock/
    bedrock: { ...BEDROCK_272K_ROUTES, effectiveDate: "2026-09-22" }
  },
  {
    pattern: /^gpt-5\.5(?:-2026-04-23)?$/,
    rate: { input: 5, cacheRead: 0.5, output: 30 },
    window: 105e4,
    cacheLifetime: "5m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  {
    pattern: /^gpt-5\.4(?:-2026-03-05)?$/,
    rate: { input: 2.5, cacheRead: 0.25, output: 15 },
    window: 105e4,
    cacheLifetime: "5m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 }
  },
  // Promotional; see PROMOTIONS below for the date and the standard rate.
  {
    pattern: /^gpt-5\.6(?:-sol)?$/,
    rate: { input: 4, cacheWrite30m: 5, cacheRead: 0.4, output: 20 },
    window: 272e3,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 },
    bedrock: {
      ...BEDROCK_272K_ROUTES,
      model: "gpt-5.6-sol",
      effectiveDate: "2026-08-21",
      profileEffectiveDate: "2026-08-20"
    }
  },
  {
    pattern: /^gpt-5\.6-terra$/,
    rate: { input: 2, cacheWrite30m: 2.5, cacheRead: 0.2, output: 12 },
    window: 272e3,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 },
    bedrock: {
      ...BEDROCK_272K_ROUTES,
      effectiveDate: "2026-07-30",
      profileEffectiveDate: "2026-08-20"
    }
  },
  {
    pattern: /^gpt-5\.6-luna$/,
    rate: { input: 0.2, cacheWrite30m: 0.25, cacheRead: 0.02, output: 1.2 },
    window: 272e3,
    cacheLifetime: "30m",
    providers: ["openai"],
    maxPricedContext: 272e3,
    longContext: { threshold: 272e3, inputMultiplier: 2, outputMultiplier: 1.5 },
    bedrock: {
      ...BEDROCK_272K_ROUTES,
      effectiveDate: "2026-07-30",
      profileEffectiveDate: "2026-08-20"
    }
  }
];
var CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";
var MODEL_RATE_ALIASES = {
  // https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing
  [CODEX_AUTO_REVIEW_MODEL]: "gpt-5.4"
};
var CACHE_LIFETIME_MS = {
  "5m": 5 * 6e4,
  "30m": 30 * 6e4,
  "1h": 60 * 6e4
};


var COMPARE_CHUNK = 1 << 20;


var TURN_STEP_LIMIT = 60;
var CLAUDE_TOOL_ASSOCIATION_LIMIT_PER_TURN = TURN_STEP_LIMIT * 4;
var TURN_START_BYTES = 1024 * 1024;
var TURN_START_MAX_BYTES = 16 * 1024 * 1024;
var CUSTOM_TITLE_SIDECAR_BYTES = 4 * 1024;
var SESSION_HEAD_BYTES = 128 * 1024;
var UNREADABLE = Symbol("unreadable switch");
var SOURCE_START = Symbol("sourceStart");
var SOURCE_END = Symbol("sourceEnd");
var MEMBERSHIP_START = Symbol("membershipStart");
var TYPED_SKILL_ORIGIN = Symbol("typedSkillOrigin");


var META_BYTES = 128 * 1024;
var TITLE_BYTES = 512 * 1024;
var FIRST_LINE_WINDOW = 16 * 1024;
var CODEX_STAT_ACTIVE_MS = 10 * 6e4;
var CODEX_DISPATCH_BLOOM_BYTES = 64 * 1024;
var CODEX_SOURCE_START = Symbol("codexSourceStart");
var CODEX_SOURCE_END = Symbol("codexSourceEnd");
var CODEX_MEMBERSHIP_START = Symbol("codexMembershipStart");
var CODEX_STRUCTURAL_AGENT = Symbol("codexStructuralAgent");
var CODEX_STRUCTURAL_END = Symbol("codexStructuralEnd");
var CODEX_STRUCTURAL_BASE = Symbol("codexStructuralBase");


var BLUE = "#4a9fe0";
var YELLOW = "#d6b33c";
var GREEN = "#5db56b";
var ORANGE = "#e08a4a";
var PURPLE = "#a98be0";
var RED = "#e06a5c";
var TEAL = "#43b0a3";
var PINK = "#dd7bb0";
function table(entries) {
  return Object.assign(/* @__PURE__ */ Object.create(null), entries);
}
var BY_EXTENSION = table({
  ts: { label: "TS", colour: BLUE },
  tsx: { label: "TSX", colour: BLUE },
  mts: { label: "TS", colour: BLUE },
  cts: { label: "TS", colour: BLUE },
  js: { label: "JS", colour: YELLOW },
  mjs: { label: "JS", colour: YELLOW },
  cjs: { label: "JS", colour: YELLOW },
  jsx: { label: "JSX", colour: YELLOW },
  json: { label: "{ }", colour: YELLOW },
  jsonc: { label: "{ }", colour: YELLOW },
  md: { label: "MD", colour: BLUE },
  markdown: { label: "MD", colour: BLUE },
  mdx: { label: "MDX", colour: BLUE },
  html: { label: "< >", colour: ORANGE },
  htm: { label: "< >", colour: ORANGE },
  xml: { label: "XML", colour: ORANGE },
  svg: { label: "SVG", colour: ORANGE },
  css: { label: "CSS", colour: BLUE },
  scss: { label: "SASS", colour: PINK },
  sass: { label: "SASS", colour: PINK },
  less: { label: "LESS", colour: BLUE },
  py: { label: "PY", colour: BLUE },
  rb: { label: "RB", colour: RED },
  go: { label: "GO", colour: TEAL },
  rs: { label: "RS", colour: ORANGE },
  java: { label: "JAVA", colour: RED },
  kt: { label: "KT", colour: PURPLE },
  swift: { label: "SWFT", colour: ORANGE },
  c: { label: "C", colour: BLUE },
  h: { label: "H", colour: BLUE },
  cpp: { label: "C++", colour: BLUE },
  cc: { label: "C++", colour: BLUE },
  hpp: { label: "H++", colour: BLUE },
  cs: { label: "C#", colour: PURPLE },
  php: { label: "PHP", colour: PURPLE },
  lua: { label: "LUA", colour: BLUE },
  r: { label: "R", colour: BLUE },
  sh: { label: "SH", colour: GREEN },
  bash: { label: "SH", colour: GREEN },
  zsh: { label: "SH", colour: GREEN },
  ps1: { label: "PS1", colour: BLUE },
  psm1: { label: "PS1", colour: BLUE },
  bat: { label: "BAT", colour: GREEN },
  cmd: { label: "CMD", colour: GREEN },
  yml: { label: "YML", colour: PURPLE },
  yaml: { label: "YML", colour: PURPLE },
  toml: { label: "TOML", colour: "" },
  ini: { label: "INI", colour: "" },
  cfg: { label: "CFG", colour: "" },
  conf: { label: "CONF", colour: "" },
  env: { label: "ENV", colour: "" },
  sql: { label: "SQL", colour: TEAL },
  csv: { label: "CSV", colour: GREEN },
  txt: { label: "TXT", colour: "" },
  log: { label: "LOG", colour: "" },
  pdf: { label: "PDF", colour: RED },
  png: { label: "IMG", colour: PURPLE },
  jpg: { label: "IMG", colour: PURPLE },
  jpeg: { label: "IMG", colour: PURPLE },
  gif: { label: "IMG", colour: PURPLE },
  webp: { label: "IMG", colour: PURPLE },
  ico: { label: "IMG", colour: PURPLE },
  zip: { label: "ZIP", colour: "" },
  gz: { label: "ZIP", colour: "" },
  tar: { label: "ZIP", colour: "" },
  vsix: { label: "ZIP", colour: "" },
  vue: { label: "VUE", colour: GREEN },
  svelte: { label: "SVLT", colour: ORANGE }
});
var BY_NAME = table({
  "package.json": { label: "NPM", colour: RED },
  "package-lock.json": { label: "LOCK", colour: RED },
  "tsconfig.json": { label: "TS", colour: BLUE },
  dockerfile: { label: "DOCK", colour: BLUE },
  makefile: { label: "MAKE", colour: ORANGE },
  ".gitignore": { label: "GIT", colour: ORANGE },
  ".gitattributes": { label: "GIT", colour: ORANGE },
  license: { label: "LIC", colour: "" },
  ".npmrc": { label: "NPM", colour: RED }
});


var RETAINED_FINGERPRINT_CHUNK_BYTES = 64 * 1024;


var COMMENT_ACTIONS = {
  write: "Comment",
  writeKey: "c",
  writeName: "Comment. The keyboard shortcut is c",
  editor: "Your comment",
  editorHint: "What to send back about this",
  save: "Save",
  cancel: "Cancel",
  editorKeys: "Enter saves, Shift and Enter for a new line",
  cancelKey: "Escape gives up",
  edit: "Edit this comment",
  delete: "Delete this comment",
  markOne: "comment on this line",
  markMany: "comments on this line",
  offLineOne: "comment not on any line",
  offLineMany: "comments not on any line"
};


var CARD_ACTIONS = {
  // The words for a reader's comments, folded in whole. They are declared above rather than
  // here because a const spread into one declared below it is read before it exists.
  ...COMMENT_ACTIONS,
  session: "Session",
  turnDiff: "Open the changes",
  // What the Files section's own cap offers in place of the rows it cut. The label reads "Show
  // N more files", so the button's own text already says how many rows a press adds back. The
  // toggle's other state names what a second press does instead of repeating what the first
  // one did.
  filesMoreOne: "more file",
  filesMoreMany: "more files",
  filesLess: "Show fewer files",
  openSubagentSession: "Open this subagent's session",
  openDispatchedSession: "Open this dispatched session",
  dispatchedRecord: "This dispatched session's record",
  // The row of a subagent whose session Arc cannot open. It names no action, because the row
  // performs none. It is there so the row's record has a heading when the reader opens it.
  subagentRecord: "This subagent's record",
  activityBreakdown: "Show tool breakdown",
  activityBreakdownTable: "Recorded tool invocations",
  activityBreakdownRunning: "Recorded tool invocations so far",
  activityBreakdownDifference: "Activity groups can differ.",
  activityRecorded: "recorded",
  activityRecordedSoFar: "recorded so far",
  // The skills a turn loaded, which the Activity heading opens beside the tool counts. A
  // skill is instructions the agent took on, not a tool it ran, so it is counted and drawn
  // apart from the tool mix.
  activitySkillsHeading: "Skills this turn loaded",
  activitySkillsOpen: "Open this skill",
  activitySkillsMissing: "The recorded file is no longer there.",
  // Said once under the list, and only when it holds a Codex skill. Codex proves only that it
  // read the file, never why it chose the skill, so the list says that once for every row it
  // covers rather than naming it on each row.
  activitySkillsBestEffort: "Codex skills are a best-effort match from the SKILL.md files that Codex read.",
  activitySkillsPopover: "Show the skills this turn loaded",
  openCommit: "Open this commit",
  // The label over a prompt sent after the turn had started. Said in words rather than left
  // to a rule or an indent, because the section holds two or more blocks of the reader's own
  // text and nothing else on the card says which of them the turn began with.
  askedMidTurn: "Asked while this was running",
  // A prompt the panel has sent and the transcript does not hold yet. Claude Code writes a
  // queued prompt when the agent picks it up, which is when the call it is on comes back, and
  // that was measured at 76 seconds on one real turn. Said apart from the label above,
  // because the panel knows it sent this one and does not know the agent has it.
  askedJustSent: "Just sent",
  // What the head row puts in front of the turn's duration. The row already draws when the
  // turn started, as `2 hours ago`, and a bare figure beside it reads as a second clock
  // time rather than as how long the turn ran. The word is drawn as a text node beside the
  // figure, never inside it, so the ticker keeps rewriting only the figure.
  //
  // The wording follows what the figure means. A finished turn's figure is
  // how long it took; a running turn's is how long it has taken so far, and the ticker
  // grows it once a second. A past-tense label on a turn still running says it is over.
  ranFor: "ran in",
  runningFor: "running for",
  // The section holding everything the agent said on its way to its answer: the narration
  // it wrote as it worked, and every answer it closed other than its response. The response
  // is drawn above this and never in it.
  // Retained so a replies-only Said section can be restored.
  saidSection: "Said while working",
  logRunning: "running",
  logRunShow: "Show the tool calls",
  logRunHide: "Hide the tool calls",
  logLineShow: "Show the whole line",
  logLineHide: "Hide the whole line",
  logRowsDetail: "Up and Down move between rows. Escape shuts an open row.",
  logRepliesOnly: "Show the replies only",
  logMessagesOnly: "Show the messages only",
  logEverything: "Show everything again",
  logFilterDetail: "The other rows are hidden until pressed again",
  logShowingReplies: "showing replies only",
  logShowingMessages: "showing messages only",
  logAllActivity: "All activity",
  logMessagesView: "Messages only",
  logRepliesView: "Replies only",
  logShowAllActivity: "Show all activity",
  logShowMessagesOnly: "Show messages only",
  logNoMessages: "No messages were recorded for this turn.",
  // The word that distinguishes a reply from narration in its accessible text.
  saidReplied: "Replied",
  // A single message can run to thousands of characters, so a long one opens bounded and
  // says so. Two forms, because a name that stays the same while the state moves leaves a
  // reader who cannot see the block with no way to tell which way the next press goes.
  saidMore: "Show all",
  saidLess: "Show less",
  // What a plain press on the section head does. It is the last clause of the head's spoken
  // name, the way a session heading's name ends on its own action.
  saidCollapse: "Collapse this section",
  saidExpand: "Expand this section",
  // What a press with Shift held does, which is the head's second job and the section's only
  // bulk control. One form per state of the messages under it, and the head carries none of
  // them where a Shift press would do nothing.
  saidWholeDetail: "Shift+click or Shift+Enter shows every message whole",
  saidLessDetail: "Shift+click or Shift+Enter shows less on every message",
  saidOpenWholeDetail: "Shift+click or Shift+Enter opens it with every message whole",
  codeCopy: "Copy",
  codeCopied: "Copied",
  promptMore: "Show the whole prompt",
  promptLess: "Show less",
  // The press under a prompt drawn before the response. It shows what the reader typed while
  // the turn ran, which the prompt lead folds to one line. The count leads the words.
  laterAsksShow: "more asked while it ran",
  laterAsksHide: "Hide what was asked while it ran",
  picker: "Session to show",
  // What a press on a session heading does. It is the whole of what the heading does,
  // so it is the last clause of the heading's accessible name as well as its hover.
  //
  // Two forms, one for each state. A name that stays the same while the state moves leaves
  // a reader who cannot see the twist with no way to tell which way the next press goes.
  expandAllTurns: "Expand every shown turn",
  // Leads the heading hint's second line with the full local time of the session's last
  // activity, since the heading draws no age.
  lastActive: "Last active",
  collapseAllTurns: "Collapse every shown turn",
  // The button beside the heading that opens the session's own menu: pin, archive,
  // labels, rename, and details. Named the way a rail action is, action then title, and its hint
  // carries the same words since the button binds no key of its own.
  sessionActions: "Session actions",
  sessionActionsDetail: "Pin, archive, labels, rename, and details",
  // What a search found nothing in, by the scope it actually ran over. Three claims, and
  // only one of them is ever true: "no turn says that" over a workspace, over a whole
  // session, and over the window search reads of one are different answers.
  //
  // Search keeps its own read window, which is neither the ordinary tail nor the older pages
  // the reader has loaded. A scoped search that did not reach the first turn must say so, or
  // the reader takes silence about a window for silence about the session.
  searchEmptyByScope: {
    workspace: "No turn says that. Search reads every session in this workspace.",
    session: "No turn in this session says that. Only the session on screen was searched.",
    sessionPart: "No turn says that in the part of this session that search reads."
  },
  searchWorking: "Reading every session in this workspace...",
  // While one session is pinned the search reads it alone, and the busy line must
  // not promise the whole workspace.
  searchWorkingScoped: "Reading this session...",
  // Appended to the result count, so a short list is read as the answer of the scope that
  // produced it rather than the workspace's. The workspace has no entry, because a plain
  // count already means the workspace.
  searchCountByScope: {
    session: "in this session",
    sessionPart: "in the part of this session that search reads"
  },
  searchPrompt: "you asked",
  searchSummary: "it answered",
  // One word for the whole panel. The control has always drawn an archive box, and the
  // reader calls it archiving, so the words say archive too. What it means has not
  // changed: the session keeps its turns, its pending changes and its baselines, and
  // the rail's Archived bucket brings it back.
  hideSession: "Archive this session",
  unarchiveSession: "Bring this session back",
  hideSessionHint: "Archive",
  hideSessionDetail: "Moves it to Archived. Nothing is deleted.",
  unarchiveSessionHint: "Unarchive",
  unarchiveSessionDetail: "Returns it to the list",
  // Pinning here keeps a session at the top of the rail, parsed however old it
  // gets. A different thing from showing one session alone, which a card press
  // does; the two live side by side and the words must not blur them.
  railPin: "Pin this session to the top",
  railUnpin: "Unpin this session from the top",
  railPinHint: "Pin",
  railPinDetail: "Keeps it at the top of the list",
  railUnpinHint: "Unpin",
  railUnpinDetail: "Returns it to its place by activity",
  // Said of a session another agent started rather than the reader. It names what
  // happened and not who was absent: a panel that told the reader a session was not
  // theirs would be wrong about their own work roughly once in twenty short ones, and
  // wrong in the worse direction.
  //
  // Drawn in the slot the agent name has, never beside it. Both together take the meta
  // line to two lines at the rail's default width, measured at 30px against 15px, and the
  // line breaks in the middle of the phrase and again in the middle of the time. The
  // agent's name is still said in full by the card's accessible name.
  agentRun: "run by an agent",
  // The word the meta line of the card a compact rail row opens on hover puts before a running
  // session's duration. `hoverMore` follows the count of labels the card folds, as in `+2 more`.
  hoverFor: "for",
  hoverMore: "more",
  // The way back to the top of a long session, drawn over the foot of the panel once
  // the reader has scrolled a screen past it. Its word is the whole of its name: what the
  // button shows and what it is announced by are the same string, so a reader who cannot
  // see it asks for it by exactly what a reader who can would call it. An arrow would say
  // neither, being read out by its Unicode name.
  toTop: "Back to the top",
  hiddenEmpty: "Every session is archived.",
  // Appended to the status word on a head row's hover while the turn is still to be read,
  // because the tint that says so is drawn by the stylesheet and cannot carry a hover of
  // its own.
  statusUnread: "unread",
  // The session rail's own name, for the landmark that holds its cards at wide widths.
  // Nothing on screen names the rail, so it carries this itself.
  railLabel: "Sessions",
  // The rail's own filter box. It narrows the rail alone and leaves the timeline and picker
  // on the session already chosen.
  railFilter: "Filter sessions",
  railFilterHint: "Filter sessions",
  railFilterClear: "Clear the filter and show every session",
  // The same cross over an empty box. The press gives the row back to the count, and the
  // name says so rather than offering to clear a query that has already gone.
  railFilterClose: "Close the text filter",
  // The button that hands the rail head row to the text box.
  railSearch: "Filter sessions by text",
  railSearchHint: "Filter by text",
  // The lens counts on the rail head row. Each narrows the rail to the sessions it names, so its
  // name carries the figure the reader sees and its hint says what a press leaves on screen.
  railCountActive: "Active",
  railCountSession: "session",
  railCountSessions: "sessions",
  railCountRunningHint: "Show only the sessions whose agent is working now",
  railCountActiveHint: "Show only the sessions with a live cache or activity in the last hour",
  railCountUnreadHint: "Show only the unread sessions",
  railCountInputHint: "Show only the sessions where an agent needs your input",
  railCountPressedHint: "Show every session again",
  // What the Active count's bolt says about the prompt caches of the sessions it counts. Each
  // sentence says whether any cache is warm or about to go, never how many, and never that
  // every session the count holds shares that state.
  railCountCacheWarm: "Some active sessions have a warm cache.",
  railCountCacheExpiring: "Some active sessions have a cache that is expiring.",
  railCountCacheNone: "No active session has a warm cache.",
  // Drawn in the rail when its filter leaves nothing, so the box that caused it stays on
  // screen with the way back beside it.
  railFilterEmpty: "No session matches.",
  // The list under the filter box, which offers the axes the grammar reads and the labels the
  // workspace has. It names itself because nothing on screen heads it: the box above it is a
  // box, and the rows arrive under it while the reader is part way through a word.
  railFilterOffers: "Filter suggestions",
  // Opens the spoken name of a row in that list. Every row draws an axis word and a colon,
  // and a colon is read out as punctuation or skipped, so the name says what the press does
  // rather than leaving the reader to work the grammar out from a fragment.
  railFilterTake: "Filter by",
  // The same row read out when the word under the caret opens on the negation mark, where a
  // press writes a term that drops the sessions it names instead of keeping them.
  railFilterWithout: "Filter out",
  railFilters: "View",
  railFiltersHint: "Change the view",
  railFilterAll: "All sessions",
  railFilterCustom: "Custom",
  railFilterFind: "Find a label or saved filter",
  railSortBy: "Sort by",
  railGroupBy: "Group by",
  railGroupByValues: { time: "Time", label: "Label", agent: "Agent", status: "Status", none: "None" },
  // The View menu's first row, which sets one lens in the query or none. The funnel names the rail
  // with the same word while the query holds that lens and nothing else.
  railNarrowTo: "Filter",
  railNarrowToValues: { all: "All", running: "Running", active: "Active", unread: "Unread", input: "Needs input" },
  // The line under the Filter row that chooses which lenses draw as quick filters, the counts
  // above the list.
  railHeadLensesName: "Quick filters",
  railRowsName: "Rows",
  railRowsComfortable: "Comfortable",
  railRowsCompact: "Compact",
  railRowsComfortableHint: "Draw each session with its figures and labels",
  railRowsCompactHint: "Draw each session on one line",
  railFilterPresets: "Saved filters",
  railFilterShow: "Show",
  railShowArchived: "Show archived",
  railShowRuns: "Show run by agents",
  railFilterLabels: "Labels",
  railFilterMatch: "Match terms",
  railFilterMatchName: "Match",
  railFilterLabelsMore: "more",
  railMoreShow: "Show",
  railMoreIn: "in",
  railFilterLabelsFewer: "Fewer labels",
  railFilterLabelsNone: "No labels yet. Add one from a session's Labels line.",
  railFilterMatchAll: "All",
  railFilterMatchAny: "Any",
  railFilterSaveChanges: "Save changes",
  railFilterSaveAsNew: "Save as new",
  railFilterRename: "Rename",
  railFilterDelete: "Delete",
  railFilterDeleteConfirm: "Delete it",
  railFilterName: "Name",
  railFilterNameTaken: "That filter name is already in use.",
  railFilterSave: "Save",
  railFilterCancel: "Cancel",
  // Opens the clause of a rail card's accessible name that carries the reader's own labels.
  // The chips are bare words. Dropped into the middle of a name they read as more of the
  // session's own title, and this word is what says they are not.
  //
  // The clause names every label the session carries, folded ones included. The fold
  // limits what the card draws and never what it holds.
  railLabelled: "labelled",
  // The way into the label editor from a rail card's hover row. One word, because the row
  // draws two controls beside it and the name the button is announced by carries the
  // session.
  //
  // The session heading's own line reads the same word, so one press is called one thing
  // wherever the reader meets it.
  labelOpen: "Labels",
  labelOpenDetail: "Add or remove labels",
  // What a chip on the session heading does when it is pressed. The chip draws the label and
  // nothing else, so a reader who meets a word in a box cannot tell a control from an
  // ornament, and this is the line that says which it is.
  //
  // The name the chip is announced by is built from `railFilterTake` and the axis word, the
  // way a row of the rail's own suggestions is, so one press is called one thing wherever the
  // reader meets it.
  sessionLabelFilterDetail: "Show only the sessions with this label",
  // What that same button says on a session carrying no label. The line is drawn on
  // every session, because the button on it is the only way into the editor the main
  // view shows, and `Labels` over an empty run of chips claims the session has some.
  // So the word names the press rather than what is beside it.
  sessionLabelsAdd: "Add a label",
  // The press at the end of the figures of a session another session started. The row draws
  // `from` and the name of the session that started it. The hint and the name it is
  // announced by name the relation. A dispatched session says `Dispatched`, the title of the
  // section the starting session's card files it under. A subagent says `Subagent`, one of
  // what that card files under `Subagents`, and the word UI copy uses for one. Both hints
  // end in `from`, the word the row draws.
  sessionParentWord: "from",
  sessionParentHint: { dispatched: "Dispatched from", subagent: "Subagent from", reader: "Started by you from" },
  sessionParentDetail: "Opens the session that started this one",
  sessionParentAction: "opens that session",
  // What the editor calls itself over the session it edits. The popover is drawn clear
  // of the card it was opened from, so it names the session rather than leaving the
  // reader to read it off whatever the popover covers.
  labelHeading: "Labels for",
  // The box at the top of the editor. It says both of the things the box does, because a
  // reader who types a name nothing matches is making one.
  labelFind: "Find or create a label",
  // The row under the box that makes the typed name. A verb, since the row is a button and
  // the name joined to it is what the press produces.
  labelCreate: "Create",
  // What making one also does. A label no session carries does not exist here, so the
  // press files this session under it in the same move, and the row says so rather
  // than leaving the reader to find it out from the card afterwards.
  labelCreateWhy: "And apply it to this session",
  // The key that does the same from inside the box, drawn at the row's right-hand end.
  // Named as a word, because a glyph is read out by its Unicode name.
  labelCreateKey: "Enter",
  // Drawn where the list would be in a workspace nobody has filed yet. It says what to do
  // rather than only that there is nothing, because the box above it is the whole way in
  // and an empty list says nothing about what that box is for.
  labelNone: "No label yet. Type a name and press Enter to make one.",
  // Said in a heading's and a rail card's accessible name when a session's unread count is
  // known and zero. Only then: a session never parsed has no count, and zero would be a
  // claim nothing recorded.
  sessionNothingNew: "nothing new",
  // The row under the rail's filter box, which turns what the reader typed into a section of
  // the rail under a name. Drawn only while the box holds a query, because a view over an
  // empty query is the whole rail under a second name.
  railViewSave: "Save this filter as a view",
  // What that same box asks for once the row is pressed. The reader names the view in the box
  // they typed the filter into, so no second box opens over the one they are looking at.
  railViewName: "Name this view",
  // How the name is filed, under the box the reader is typing it into. The row that named the
  // job is gone by then, so this line carries both the job and the key. Named as a word,
  // because a glyph is read out by its Unicode name.
  railViewNameKey: "Name the view, then press Enter.",
  // The way back out of naming, on the control that clears the query the rest of the time. The
  // name says what the press keeps, because the box holds a name and the reader's query is the
  // thing they would be afraid of losing.
  railViewNameCancel: "Keep the filter and save no view",
  // Drawn under a view's own heading when its query reaches no session. The heading stays
  // whatever the query finds, because it is where the view is renamed and deleted, so this line
  // says why nothing is under it.
  railViewEmpty: "No session matches this view.",
  // The editor the rename and delete commands open. It carries those two jobs and nothing else:
  // a view's query is whatever the reader had typed when they saved it.
  railViewEdit: "Edit view",
  railViewNameField: "Name",
  railViewCancel: "Cancel",
  railViewSaveAction: "Save view",
  // Deleting takes two presses on one button. The first arms it and the word changes, so the
  // reader reads what the next press does instead of answering a dialog drawn over the view.
  railViewDelete: "Delete this view",
  railViewDeleteConfirm: "Delete it",
  // The editor Rename session opens on a saved rail row. The empty note matches the answer
  // the extension gives an empty name, so the reader reads one sentence for one problem.
  sessionRename: "Rename session",
  sessionRenameField: "Name",
  sessionRenameCancel: "Cancel",
  sessionRenameSave: "Save name",
  sessionRenameEmpty: "Enter a name.",
  sessionRenamePending: "Renaming session..."
};


var TURN_MENU_SECTIONS = {
  read: "arcTurnRead",
  unread: "arcTurnUnread",
  readSummary: "arcTurnReadSummary",
  unreadSummary: "arcTurnUnreadSummary",
  summary: "arcTurnSummary"
};


var LABEL_NAME_LIMIT = 40;
var LABEL_NOTES = {
  comma: "A comma in a name reads as two labels when a card is read out.",
  limit: `A name is cut to ${LABEL_NAME_LIMIT} characters. Two names that agree that far are one label.`
};


var VIEW_NAME_LIMIT = 40;
var VIEW_QUERY_LIMIT = 200;
var VIEW_NOTES = {
  taken: "A view already has that name. Choose another name.",
  unnamed: "A view needs a name. Type one to save it.",
  limit: `A name is cut to ${VIEW_NAME_LIMIT} characters. Two names that agree that far are one view.`
};


var RAIL_FILTER_QUERY_LIMIT = VIEW_QUERY_LIMIT;
var OLD_NEEDS_YOU_WORDS = "is:needsyou -is:archived -is:agentrun";
var RESERVED_RAIL_FILTER_NAMES = [
  "All sessions",
  "Running",
  "Active",
  "Unread",
  "Needs input",
  "Needs you",
  "Custom"
];
var RESERVED_RAIL_FILTER_KEYS = new Set(RESERVED_RAIL_FILTER_NAMES.map((name) => railFilterKey(name)));
var RAIL_LENSES = ["running", "active", "unread", "input"];
var RAIL_LENS_WORDS = {
  running: "is:running -is:archived -is:agentrun",
  active: "is:active -is:archived -is:agentrun",
  unread: "is:unread -is:archived -is:agentrun",
  input: "is:input -is:archived -is:agentrun"
};
var RAIL_FILTER_STORED_QUERY_LIMIT = RAIL_FILTER_QUERY_LIMIT + Math.max(OLD_NEEDS_YOU_WORDS.length, ...RAIL_LENSES.map((lens) => RAIL_LENS_WORDS[lens].length)) + 1;
function railFilterKey(name) {
  return name.toLocaleLowerCase();
}


var ACTIVE_WINDOW_MS = 60 * 60 * 1e3;
var RAIL_GROUP_FOLD_PREFIX = "railgroup:";
var VIEW_FOLD_PREFIX = `${RAIL_GROUP_FOLD_PREFIX}view:`;
var RAIL_ALL_ID = `${RAIL_GROUP_FOLD_PREFIX}all`;


var MARKS = [
  { id: "needsYou", character: "\u{1F64B}", word: "needs you" },
  { id: "question", character: "\u2753", word: "an open question" },
  { id: "blocked", character: "\u26D4", word: "blocked" },
  { id: "caveat", character: "\u26A0", word: "a caveat" },
  { id: "unfinished", character: "\u{1F6A7}", word: "unfinished" },
  { id: "done", character: "\u2705", word: "done" },
  { id: "finding", character: "\u{1F50D}", word: "a finding" },
  { id: "proposal", character: "\u{1F4A1}", word: "a proposal" },
  { id: "gap", character: "\u{1F573}", word: "a gap in what it recorded" },
  { id: "commit", character: "\u{1F516}", word: "committed" },
  { id: "tests", character: "\u{1F9EA}", word: "tests" },
  { id: "docs", character: "\u{1F4C4}", word: "docs" },
  { id: "removal", character: "\u{1F53B}", word: "more taken out than put in" },
  { id: "agents", character: "\u{1F465}", word: "subagents" },
  { id: "context", character: "\u{1F4C8}", word: "context filling up" }
];
var MARK_BY_CHARACTER = new Map(MARKS.map((m) => [m.character, m]));
var TURN_MENU_SECTIONS2 = {
  ...TURN_MENU_SECTIONS
};
var TURN_QUIET_MS = 60 * 60 * 1e3;
var CONTEXT_BANDS = [
  { at: 0.5, level: "filling", word: "context filling up" },
  { at: 0.75, level: "gettingFull", word: "context getting full" },
  { at: 0.9, level: "nearlyFull", word: "context nearly full" }
];
var HANDOFF_LEVELS = CONTEXT_BANDS.slice(1).map((b) => b.level);
var FILE_COUNT_CAUSES = {
  write: ({ count, files, was }) => `${count} ${files} ${was} written whole`,
  shell: ({ count, files, was, its }) => `${count} ${files} ${was} named by the shell without ${its} lines`,
  replaceAll: ({ count, files, was }) => `${count} ${files} ${was} edited with replace_all, which does not say how many times it matched`,
  // The notebook's cells rather than one cell, so the clause stays true of a file that lost
  // several cells and of several files at once.
  notebook: ({ count, files, was, its, plural }) => `${count} ${files} ${was} ${plural ? "notebooks" : "a notebook"} edited with no record of what ${its} cells held before`,
  zero: ({ count, files, was }) => `${count} ${files} ${was} edited with nothing a line count can see`
};
var FILE_COUNT_CAUSE_ORDER = Object.keys(FILE_COUNT_CAUSES);


var counts = (over = {}) => ({
  edits: 0,
  reads: 0,
  searches: 0,
  commands: 0,
  agents: 0,
  coordination: 0,
  web: 0,
  other: 0,
  ...over
});
var turn = (over = {}) => ({
  agent: "claude",
  sessionId: "sess",
  sessionTitle: null,
  promptId: "p",
  startedAt: new Date(2026, 7, 23, 14, 32).getTime(),
  endedAt: new Date(2026, 7, 23, 14, 44).getTime(),
  prompt: "address the review findings",
  summary: "",
  answers: [],
  model: "claude-opus-5",
  effort: null,
  files: [],
  agents: [],
  commits: [],
  usage: { requests: 0, input: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, output: 0, thinking: 0 },
  contextTokens: 0,
  contextWindow: null,
  toolUses: 0,
  toolCounts: counts(),
  toolTally: {},
  laterPrompts: [],
  steps: [],
  updates: [],
  stepCount: 0,
  stepKinds: [],
  failedOrdinals: [],
  failures: [],
  skillUses: [],
  skillUseCount: 0,
  interrupted: false,
  finished: true,
  error: null,
  ...over
});
var HEAVY_ROOT = "c:/users/developer/source/repos/agent-diff-review";
var HEAVY_REPOSITORY = { key: `${HEAVY_ROOT}/.git`, root: HEAVY_ROOT, own: true };
var RECORD_AT = new Date(2026, 7, 23, 16, 0).getTime();
var livePress = (over = {}) => ({
  sessionId: "sess",
  agent: "claude",
  kind: "prompt",
  text: "Keep the live prompt visible.",
  reply: "",
  at: 2e3,
  midTurn: false,
  ran: true,
  started: true,
  failed: false,
  reason: "",
  ...over
});
var NOW = new Date(2026, 7, 23, 20, 0).getTime();
var MB = 1024 * 1024;
var TURN_AT = new Date(2026, 7, 23, 14, 32).getTime();
var powershellDispatchCommand = "$runPath='C:/fixtures/arc/.claude/ship-logs/2026-09-30-rail-head-phase3-132913-758280594ce0090c'\npython C:/tools/dispatch.py --runner claude --model claude-opus-5-5 --effort high --cwd 'C:/fixtures/arc/.claude/worktrees/2026-09-30-rail-head-phase3-132913-758280594ce0090c' --prompt (Join-Path $runPath 'implementation-prompt.md') --log (Join-Path $runPath 'implementation.log') --name rail-head-phase3-implement --add-dir C:/fixtures/arc --notify-thread 01a0eea1-3eec-7832-affb-83676f62b6a0 --arc-dispatch | Tee-Object -FilePath (Join-Path $runPath 'implementation-launch.txt')";
var powershellDispatchExecution = {
  type: "CommandExecution",
  id: "exec-3b1ba415-d922-4de5-8953-f32c4e7d1dd3",
  command: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", powershellDispatchCommand],
  cwd: "file:///C:/fixtures/arc",
  parsed_cmd: [{ type: "unknown", cmd: powershellDispatchCommand }],
  source: "unified_exec_startup",
  status: "completed",
  stdout: `${ARC_IDENTITY.environmentPrefix}DISPATCH_SESSION={"agent":"claude","session_id":"3f99580e","name":"rail-head-phase3-implement"}\r
`,
  stderr: "",
  exit_code: 0
};
var COMPACTION_SAMPLES = [
  {
    name: "C3",
    model: "claude-opus-5",
    trigger: "auto",
    previousRead: 166768,
    previousWrite: 113,
    firstRead: null,
    idleMinutes: 1 / 3,
    lifetime: "5m",
    summaryChars: 6266,
    postTokens: 3047,
    realCost: 0.1815
  },
  {
    name: "C10 a",
    model: "claude-sonnet-5",
    trigger: "auto",
    previousRead: 156913,
    previousWrite: 21907,
    firstRead: null,
    idleMinutes: 1 / 3,
    lifetime: "5m",
    summaryChars: 6034,
    postTokens: 3090,
    realCost: 0.1022
  },
  {
    name: "C10o a",
    model: "claude-sonnet-5",
    trigger: "auto",
    previousRead: 156913,
    previousWrite: 21702,
    firstRead: null,
    idleMinutes: 1 / 3,
    lifetime: "5m",
    summaryChars: 4566,
    postTokens: 2678,
    realCost: 0.0926
  },
  {
    name: "630c5f4e cold on claude-opus-5",
    model: "claude-opus-5",
    trigger: "manual",
    previousRead: 259151,
    previousWrite: 601,
    firstRead: 12582,
    idleMinutes: 72,
    lifetime: "1h",
    summaryChars: 17192,
    postTokens: null,
    realCost: 1.5671
  },
  {
    name: "630c5f4e warm",
    model: "claude-opus-5-5",
    trigger: "manual",
    previousRead: 213428,
    previousWrite: 1072,
    firstRead: null,
    idleMinutes: 29,
    lifetime: "1h",
    summaryChars: 19326,
    postTokens: null,
    realCost: 0.2078
  },
  {
    name: "386c0253 cold",
    model: "claude-opus-5-5",
    trigger: "manual",
    previousRead: 228615,
    previousWrite: 1473,
    firstRead: 10086,
    idleMinutes: 818,
    lifetime: "1h",
    summaryChars: 18532,
    postTokens: null,
    realCost: 1.0501
  },
  {
    name: "630c5f4e cold on claude-opus-5-5",
    model: "claude-opus-5-5",
    trigger: "manual",
    previousRead: 152863,
    previousWrite: 898,
    firstRead: 12582,
    idleMinutes: 996,
    lifetime: "1h",
    summaryChars: 18003,
    postTokens: null,
    realCost: 0.737
  },
  {
    name: "0d62124b warm",
    model: "claude-opus-5-5",
    trigger: "manual",
    previousRead: 84939,
    previousWrite: 2877,
    firstRead: null,
    idleMinutes: 2,
    lifetime: "5m",
    summaryChars: 6380,
    postTokens: null,
    realCost: 0.0868
  },
  {
    name: "b8bab4d2 cold",
    model: "claude-opus-5-5",
    trigger: "manual",
    previousRead: 102348,
    previousWrite: 419,
    firstRead: 10086,
    idleMinutes: 1309,
    lifetime: "1h",
    summaryChars: 5177,
    postTokens: null,
    realCost: 0.413
  },
  {
    name: "fb1756cf warm after a cache miss",
    model: "claude-opus-5-5",
    trigger: "manual",
    previousRead: 10086,
    previousWrite: 126961,
    firstRead: null,
    idleMinutes: 1.5,
    lifetime: "5m",
    summaryChars: 10634,
    postTokens: null,
    realCost: 0.714
  }
];


import assert from "node:assert";
var require2 = createRequire(import.meta.url);
var ROOT = process.argv[2];
var RUNTIME = require2(ROOT + "/runtime.cjs");
var { emptyTrail } = RUNTIME.modules["extension/src/turnplaces.ts"];
var { SessionNames } = RUNTIME.modules["extension/src/sessionnames.ts"];
var { normalizePanelState } = RUNTIME.modules["extension/src/turnview.ts"];
var { composerRuntimeBySession } = RUNTIME.modules["extension/src/turncard.ts"];
function stateForRow(rows, drafts, id, selected = {}, overrides = {}) {
  const host = {
    newestBySession: selected.newest ?? /* @__PURE__ */ new Map(),
    newestCompactionBySession: selected.compactions ?? /* @__PURE__ */ new Map(),
    composerRuntime: selected.runtime ?? composerRuntimeBySession([...selected.newest?.values() ?? []], selected.compactions ?? /* @__PURE__ */ new Map()),
    picks: overrides.picks ?? {},
    newDrafts: drafts,
    // The other book a draft's setup lives in, holding a setup nothing here ever wrote. The
    // composer must draw the frozen draft's own profile, because that copy is the one `send`
    // hands to the callback that starts the child.
    draftProfiles: Object.fromEntries(Object.keys(drafts).map((id2) => [id2, OTHER_BOOK_SETUP])),
    sessionRows: rows,
    sessionOrigins: {},
    drafts: {},
    boxText: {},
    sentPrompts: {},
    promptsBySession: /* @__PURE__ */ new Map(),
    queues: {},
    running: /* @__PURE__ */ new Set(),
    saved: { comments: [] },
    models: {},
    commandLists: overrides.commandLists ?? {},
    claudeSkillPaths: /* @__PURE__ */ new Map(),
    skillLists: overrides.skillLists ?? {},
    catalog: overrides.catalog ?? null,
    awaitingSessionRecords: overrides.awaitingSessionRecords ?? {},
    folders: overrides.folders ?? (() => []),
    cwdForSession: PanelProvider.prototype.cwdForSession,
    ownCwdForSession: PanelProvider.prototype.ownCwdForSession,
    claudeCommandsFor: PanelProvider.prototype.claudeCommandsFor,
    mcpServers: {},
    askLevels: overrides.askLevels ?? {},
    codexEffectiveModes: overrides.codexEffectiveModes ?? {},
    claudeEffectiveModes: overrides.claudeEffectiveModes ?? {},
    live: {},
    asks: [],
    draftCommentIds: {},
    promptAssets: () => [],
    attachmentNotices: {}
  };
  return PanelProvider.prototype.stateForRow.call(host, rows.find((row) => row.id === id));
}
var OTHER_BOOK_SETUP = {
  agent: "codex",
  model: "gpt-5",
  effort: "medium",
  permissionMode: "on-request",
  source: "recent"
};
function liveProviderFixture(press, newest = turn({ startedAt: press.at - 1e3 })) {
  const posted = [];
  const provider = Object.create(PanelProvider.prototype);
  const host = { webview: {}, visible: () => true };
  Object.assign(provider, {
    sessionNames: new SessionNames(),
    hosts: [host],
    readyHosts: /* @__PURE__ */ new Set([host]),
    showing: press.sessionId,
    hostSessions: /* @__PURE__ */ new Map([[host, press.sessionId]]),
    hostPreviousSessions: /* @__PURE__ */ new Map([[host, press.sessionId]]),
    live: { [press.sessionId]: [press] },
    running: /* @__PURE__ */ new Set(),
    runningSinceKeys: /* @__PURE__ */ new Map(),
    assetCompletions: {
      begin() {
        return 1;
      }
    },
    assetHandoffs: /* @__PURE__ */ new Set(),
    assetIdsInHandoff: /* @__PURE__ */ new Set(),
    attachmentStorageDir: null,
    livePressHosts: /* @__PURE__ */ new Map(),
    exitedSinceKeys: /* @__PURE__ */ new Map(),
    sessionOutcomes: /* @__PURE__ */ new Map(),
    newestBySession: /* @__PURE__ */ new Map([[press.sessionId, newest]]),
    newestCompactionBySession: /* @__PURE__ */ new Map(),
    liveActivity: {},
    activitySessions: /* @__PURE__ */ new Set(),
    activityPost: null,
    replyPost: null,
    cards: [],
    turnsByKey: /* @__PURE__ */ new Map(),
    repositoryScopeReady: true,
    sessionRows: [{ id: press.sessionId, label: "Session", agentKey: press.agent, shown: true }],
    picks: {},
    newDrafts: {},
    drafts: {},
    boxText: {},
    assets: {},
    attachmentNotices: {},
    queues: {},
    draftCommentIds: {},
    queueHandoffs: {},
    promptsBySession: /* @__PURE__ */ new Map(),
    sentPrompts: {},
    saved: { comments: [] },
    models: {},
    commandLists: {},
    skillLists: {},
    mcpServers: {},
    askLevels: {},
    asks: [],
    sessionAliases: /* @__PURE__ */ new Map(),
    clearRoutes: /* @__PURE__ */ new Map(),
    awaitingSessionRecords: {},
    recentProfiles: [],
    usage: [],
    sessionOrigins: {},
    selectionWork: null,
    selectionFailure: null,
    selectionGeneration: 1,
    history: /* @__PURE__ */ new Map(),
    historyStructuralKeys: /* @__PURE__ */ new Map(),
    cache: /* @__PURE__ */ new Map(),
    authoritativeCatalog: [{ sessionId: press.sessionId, file: "record.jsonl", agent: press.agent }],
    anyVisible: () => true,
    revisionOf: () => ({ mtimeMs: 10, size: 10 }),
    structuralKey: () => "",
    progressiveCurrent: () => false,
    progressiveInput: () => ({}),
    dropOlderHistory: () => void 0,
    folders: () => [],
    postRail: () => void 0,
    refresh: () => Promise.resolve(),
    themedFor: (cards) => cards,
    performanceCounters: { registerPanel() {
    }, releasePanel() {
    } },
    sendToHost: (_host, message) => {
      posted.push(message);
      return Promise.resolve(true);
    }
  });
  const call = provider;
  const usage = (message) => message.usage.composer.live;
  const publishUsage = async () => {
    await call.post({ type: "usage" });
    return posted.at(-1);
  };
  return { provider, call, host, posted, usage, publishUsage };
}
function pendingModelLauncher() {
  const owner = { webview: {}, active: () => true };
  const before = { size: 1e4, mtimeMs: 1, dev: 1, ino: 2 };
  const revision = { ...before, mtimeMs: 2 };
  const session = { file: "source.jsonl", sessionId: "source", agent: "claude", ...revision };
  const catalog = ["opus", "opus[1m]"].map((value) => ({
    value,
    resolvedModel: `claude-opus-5-5${value === "opus" ? "" : "[1m]"}`,
    label: value,
    description: "",
    efforts: [{ value: "high", label: "High", description: "" }]
  }));
  const provider = Object.create(PanelProvider.prototype);
  const created = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const read = {
    turns: [
      turn({ sessionId: "source", model: "claude-opus-5-5", modelAttachment: "claude-opus-5-5[1m]", effort: "high" })
    ],
    compactions: [],
    readBytes: 2048
  };
  const result = {
    generation: 1,
    revision,
    value: {
      kind: "window",
      read,
      checkpoint: { attachmentRecovery: { status: "complete" } },
      recoveryPending: false,
      agentKey: "",
      structuralKey: "",
      retainedBytes: 100,
      checkpointBytes: 100,
      reset: true,
      appendFrom: null
    }
  };
  Object.assign(provider, {
    disposed: false,
    selectionGeneration: 1,
    attachmentHandoffs: /* @__PURE__ */ new Set(),
    hosts: [owner],
    hostSessions: /* @__PURE__ */ new Map([[owner, "source"]]),
    showing: "source",
    authoritativeCatalog: [session],
    cache: /* @__PURE__ */ new Map([
      [
        session.file,
        {
          revision: before,
          read: { turns: [], compactions: [] },
          checkpoint: { attachmentRecovery: { status: "pending" } }
        }
      ]
    ]),
    history: /* @__PURE__ */ new Map([
      [
        "source",
        {
          sessionId: "source",
          size: before.size,
          mtimeMs: before.mtimeMs,
          pages: [{ turns: [turn({ sessionId: "source", prompt: "stale" })] }]
        }
      ]
    ]),
    historyStructuralKeys: /* @__PURE__ */ new Map(),
    composerRuntime: /* @__PURE__ */ new Map(),
    turnsByKey: /* @__PURE__ */ new Map(),
    saved: normalizePanelState(null),
    revisionOf: () => revision,
    folders: () => ["C:/workspace"],
    progressiveInput: () => ({ session }),
    progressiveWorker: { run: () => pending },
    recordedCwdForSession: () => "C:/workspace",
    models: { claude: catalog },
    recentProfiles: [],
    pinnedSetups: [],
    composerStateFor: () => {
      const state = stateForRow([{ id: "source", label: "Source", agentKey: "claude" }], {}, "source", {
        runtime: provider.composerRuntime
      });
      state.models = catalog;
      return state;
    },
    stateFor: () => provider.composerStateFor("source", owner.webview),
    createDraft: (...args) => {
      created.push(args);
      if (args[7]) provider.saved.readerParents[args[0]] = args[2];
    },
    abandonDraft: () => false,
    writeDrafts: () => Promise.resolve(),
    sendToHost: () => Promise.resolve(true),
    post: () => Promise.resolve()
  });
  const finish2 = provider.finishHandoffRecovery.bind(provider);
  let completion;
  provider.finishHandoffRecovery = (...args) => {
    completion = finish2(...args);
    return completion;
  };
  return { provider, owner, created, release, result, completed: () => completion };
}
test.each([false, true])("the first reader child selection includes its parent (recovery %s)", async (recovery) => {
  const f = pendingModelLauncher();
  const provider = f.provider;
  const defaults2 = liveProviderFixture(livePress({ sessionId: "source", agent: "claude" })).provider;
  for (const [key, value] of Object.entries(defaults2)) {
    if (!Object.hasOwn(provider, key)) provider[key] = value;
  }
  const posted = [];
  Object.assign(provider, {
    readyHosts: /* @__PURE__ */ new Set([f.owner]),
    anyVisible: () => true,
    hostPreviousSessions: /* @__PURE__ */ new Map([[f.owner, "source"]]),
    repositoryScopeRoots: ["C:/workspace"],
    draftProfiles: {},
    refreshGeneration: 1,
    trail: emptyTrail(),
    windows: /* @__PURE__ */ new Map(),
    seenTurns: /* @__PURE__ */ new Map(),
    turnMarks: /* @__PURE__ */ new Map(),
    readWindows: /* @__PURE__ */ new Map(),
    hidden: /* @__PURE__ */ new Set(),
    pinnedTop: /* @__PURE__ */ new Set(),
    performanceCounters: { recordRefreshStage() {
    }, recordRefresh() {
    }, recordStartup() {
    } },
    shownSessions: () => [],
    activityFor: () => 1,
    outcomesFor: () => /* @__PURE__ */ new Map(),
    agentListingStamp: () => "",
    sessionParentEdges: () => ({ key: "", edges: /* @__PURE__ */ new Map(), dispatched: /* @__PURE__ */ new Map() }),
    glanceAt: () => /* @__PURE__ */ new Map(),
    dropSpentPresses: () => false,
    liveOpenChildren: () => /* @__PURE__ */ new Map(),
    liveBackgroundCommands: () => /* @__PURE__ */ new Map(),
    evictCache() {
    },
    collect: () => [],
    unreadCounts: () => /* @__PURE__ */ new Map(),
    pruneExits() {
    },
    sessionLabel: () => ({ label: "Source", fullLabel: "Source" }),
    agentRunFor: () => false,
    drainInitialCatalogRefresh() {
    },
    drainPendingQueues() {
    },
    metaFor: () => ({ starts: [] }),
    metadataStatFigures: { read: () => ({}) },
    metadataCacheFigures: { read: () => ({}) },
    railStatuses: () => ({ statuses: /* @__PURE__ */ new Map(), openChildren: /* @__PURE__ */ new Map() }),
    railInputFor: (_counts, _statuses, _children, now, showing = provider.showing) => ({
      sessions: provider.sessionRows,
      counts: /* @__PURE__ */ new Map(),
      newest: /* @__PURE__ */ new Map(),
      statuses: /* @__PURE__ */ new Map(),
      runningSince: /* @__PURE__ */ new Map(),
      openChildren: /* @__PURE__ */ new Map(),
      hidden: /* @__PURE__ */ new Set(),
      showing,
      pinnedTop: /* @__PURE__ */ new Set(),
      unsent: /* @__PURE__ */ new Map(),
      parsedStats: {},
      metadataStats: {},
      lifetimeStats: {},
      lifetimeCosts: {},
      labels: {},
      caches: {},
      views: [],
      railFilters: [],
      now
    }),
    lifetimeFigures: { answers: () => /* @__PURE__ */ new Map() },
    projectSpendPayload: () => null,
    usagePayloadForSession: () => ({}),
    checkpointDerivedCache() {
    },
    ensureProjectSpendWorkspace() {
    },
    createDraft: PanelProvider.prototype.createDraft,
    refresh: PanelProvider.prototype.refresh,
    sendToHost: (_owner, message) => {
      posted.push(message);
      return Promise.resolve(true);
    }
  });
  if (!recovery)
    provider.cache.set("source.jsonl", {
      ...provider.cache.get("source.jsonl"),
      ...f.result.value,
      revision: f.result.revision
    });
  provider.detailsMenuArm = { host: f.owner, session: "source", at: Date.now() };
  provider.newSessionWithLabels("source");
  if (recovery) {
    assert.equal(posted.length, 0);
    f.release(f.result);
    await f.completed();
  }
  const [child] = Object.keys(provider.newDrafts);
  assert.ok(child, "the reader action did not create its child");
  const selections = posted.filter((message) => message.type === "selection");
  assert.equal(selections.length, 1, "creation must publish one initial selection");
  assert.equal(selections[0].showing, child);
  assert.deepEqual(
    selections[0].sessions.find((row) => row.id === child)?.parent,
    {
      id: "source",
      label: "Source",
      relation: "reader"
    },
    "the first child selection omitted its parent control"
  );
});
var PanelProvider = RUNTIME.modules["extension/src/panelhost.ts"].PanelProvider;
test("ordinary New leaves no reader parent", () => {
  const f = pendingModelLauncher();
  const p = f.provider;
  const created = [];
  p.attachmentRecoveryPending = () => false;
  p.launcherFor = () => ({ owner: f.owner, state: null, view: RUNTIME.modules["extension/src/composerview.ts"].sessionLauncherView(null, [], { claude: p.models.claude }) });
  p.createDraft = (...args) => created.push(args);
  const request = { kind: "custom", agent: "claude", model: "opus", effort: "high", permissionMode: "" };
  assert.equal(p.newSession(request, f.owner), true);
  assert.equal(created.length, 1);
  assert.notEqual(created[0][7], true);
  assert.deepEqual(p.saved.readerParents, {});
  assert.equal(p.newSession({ ...request, model: "retired" }, f.owner), false);
});
await finish();
for (const directory of globalThis.qualificationDirs ?? []) require2("node:fs").rmSync(directory, { recursive: true, force: true });
