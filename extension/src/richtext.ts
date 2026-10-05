// Rich content references recorded inside assistant text.
//
// Some clients place a compact instruction in the text they save, then replace that
// instruction with an interactive surface when they draw the response. The transcript is
// still the source of truth, so the Timeline keeps the original summary and translates only
// the copy handed to its Markdown renderer.

import * as path from 'path';
import { marked } from 'marked';
import { isLocalLinkPath } from './domain/link-path';
import { ARC_IDENTITY } from './identity';

export const VISUALIZATION_SCHEME = ARC_IDENTITY.visualizationScheme;

const VISUALIZE_LINE = /^ {0,3}\uE200visualize\uE202(.*)\uE201[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HOST_RICH_CONTENT = /\uE200(?:[^\uE201\r\n]*\uE201|[^\r\n]*)/g;

interface VisualizationSpec {
  path: string;
  title: string | null;
}

function visualizationSpec(json: string): VisualizationSpec | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as { path?: unknown; title?: unknown };
  if (
    typeof record.path !== 'string' ||
    !path.isAbsolute(record.path) ||
    path.extname(record.path).toLowerCase() !== '.html'
  ) {
    return null;
  }
  return {
    path: path.normalize(record.path),
    title: typeof record.title === 'string' && record.title.trim() ? record.title.replace(/\s+/g, ' ').trim() : null,
  };
}

function markdownLabel(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

function visualizationName(spec: VisualizationSpec): string {
  if (spec.title) {
    return spec.title;
  }
  const stem = path.basename(spec.path, path.extname(spec.path)).replace(/[-_]+/g, ' ').trim();
  if (!stem) {
    return 'Visualization';
  }
  return stem[0].toUpperCase() + stem.slice(1);
}

function visualizationAction(spec: VisualizationSpec): string {
  return `Open interactive visualization: ${visualizationName(spec)}`;
}

function translateVisualizationLines(text: string, replacement: (spec: VisualizationSpec | null) => string): string {
  let fence: { char: string; size: number } | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line);
      if (marker) {
        const next = { char: marker[1][0], size: marker[1].length };
        if (!fence) {
          fence = next;
        } else if (next.char === fence.char && next.size >= fence.size) {
          fence = null;
        }
        return line;
      }
      if (fence) {
        return line;
      }
      const reference = VISUALIZE_LINE.exec(line.replace(/\r$/, ''));
      return reference ? replacement(visualizationSpec(reference[1])) : line;
    })
    .join('\n');
}

// Translate host-only references into the plain words a compact surface can draw. Unlike
// the Markdown form below, this carries no link syntax for punctuation in a title to escape.
export function readableRichText(text: string): string {
  return translateVisualizationLines(text, (spec) =>
    spec ? visualizationAction(spec) : 'Interactive visualization is unavailable.',
  );
}

// Remove host-only rich content from a surface that accepts plain text only. This does not
// interpret the payload: a complete record and a truncated one are both absent from a title.
export function withoutRichContent(text: string): string {
  return text.replace(HOST_RICH_CONTENT, ' ').replace(/[\uE200-\uE202]/g, ' ');
}

// Replace a host-only visualization line with ordinary Markdown the Timeline can draw.
// Fenced examples stay literal, and malformed references become an honest fallback instead
// of exposing private-use control characters to the reader.
export function richMarkdown(text: string): string {
  return translateVisualizationLines(text, (spec) => {
    if (!spec) {
      return 'Interactive visualization is unavailable.';
    }
    const label = markdownLabel(visualizationAction(spec));
    return `[${label}](${VISUALIZATION_SCHEME}${encodeURIComponent(spec.path)})`;
  });
}

// The href produced above, back to the local HTML file it names. Unknown schemes, malformed
// escapes, relative paths and non-HTML targets are rejected at the boundary.
export function visualizationPath(href: string): string | null {
  if (!href.startsWith(VISUALIZATION_SCHEME)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.slice(VISUALIZATION_SCHEME.length));
  } catch {
    return null;
  }
  return visualizationSpec(JSON.stringify({ path: decoded }))?.path ?? null;
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] || character,
  );
}

interface MarkdownDisclosure {
  start: number;
  openingEnd: number;
  end: number;
  headingStart: number;
  headingEnd: number;
  bodyStart: number;
  bodyEnd: number;
  children: MarkdownDisclosure[];
  valid: boolean;
}

// Match structure before Markdown lexing, which otherwise consumes tight bodies as HTML.
// Literal regions never supply tags. The disclosure depth bounds rendering and disclosure stack storage.
function markdownDisclosures(text: string): MarkdownDisclosure[] {
  const literal = new Uint8Array(text.length);
  const pending: { text: string; positions: number[] | null }[] = [{ text, positions: null }];
  while (pending.length) {
    const { text, positions } = pending.pop()!;
    const position = (index: number): number => (positions ? positions[index] : index);
    const mark = (start: number, end: number): void => {
      if (!positions) literal.fill(1, start, end);
      else for (let index = start; index < end; index += 1) literal[positions[index]] = 1;
    };
    const container = (raw: string, body: string, start: number): void => {
      // Marked removes container prefixes, task markers, and final whitespace.
      // Match each remaining line's suffix to retain positions in the original source.
      body = body.replace(/^( *)(\t+)/gm, (_, spaces, tabs) => spaces + '    '.repeat(tabs.length));
      const rawLines = raw.split('\n');
      const bodyLines = body.split('\n');
      const mapped: number[] = [];
      let rawOffset = start;
      for (let line = 0; line < bodyLines.length; line += 1) {
        const content = bodyLines[line].trimStart();
        const head = bodyLines[line].length - content.length;
        const contentStart = rawLines[line].lastIndexOf(content);
        for (let index = 0; index < bodyLines[line].length; index += 1) {
          mapped.push(position(rawOffset + Math.max(0, contentStart - head + index)));
        }
        if (line < bodyLines.length - 1) mapped.push(position(rawOffset + rawLines[line].length));
        rawOffset += rawLines[line].length + 1;
      }
      pending.push({ text: body, positions: mapped });
    };
    const tokenizer = new marked.Tokenizer() as marked.Tokenizer & marked.TokenizerThis;
    // Initialize the same block rules that render the disclosure's Markdown body.
    tokenizer.lexer = new marked.Lexer({ gfm: true, breaks: true, tokenizer });
    let offset = 0;
    while (offset < text.length) {
      const source = text.slice(offset);
      const block = (tokenizer.space(source) ?? tokenizer.fences(source) ?? tokenizer.code(source)) as
        | marked.Tokens.Space
        | marked.Tokens.Code
        | undefined;
      if (block) {
        if (block.type === 'code') mark(offset, offset + block.raw.length);
        offset += block.raw.length;
        continue;
      }
      const tag = /^ {0,3}<\/?(?:details|summary)\b[^>]*>/i.exec(source);
      if (tag) {
        offset += tag[0].length;
        continue;
      }
      const quote = tokenizer.blockquote(source);
      if (quote) {
        container(quote.raw, quote.text, offset);
        offset += quote.raw.length;
        continue;
      }
      const list = tokenizer.list(source);
      if (list) {
        let itemOffset = offset;
        for (const item of list.items) {
          container(item.raw, item.text, itemOffset);
          itemOffset += item.raw.length;
        }
        offset += list.raw.length;
        continue;
      }
      const html = tokenizer.html(source);
      if (html) {
        mark(offset, offset + html.raw.length);
        offset += html.raw.length;
        continue;
      }
      const raw = (tokenizer.paragraph(source) ?? tokenizer.text(source)).raw;
      let end = offset + raw.length;
      // Pair ticks within one Markdown block. Comments and spans consume source in order.
      // Backslashes escape opening ticks, but code spans accept unescaped closing runs.
      const markers = [...raw.matchAll(/<!--|`+/g)];
      const nextTick = new Map<number, number>();
      const nextSize = new Map<number, number>();
      const escaped = new Set<number>();
      for (let i = markers.length - 1; i >= 0; i -= 1) {
        const run = markers[i];
        let slashes = 0;
        for (let at = offset + run.index - 1; at >= 0 && text[at] === '\\'; at -= 1) slashes += 1;
        if (slashes % 2) escaped.add(i);
        if (run[0] === '<!--') continue;
        const size = run[0].length - (escaped.has(i) ? 1 : 0);
        const next = nextSize.get(size);
        if (next !== undefined) nextTick.set(i, next);
        nextSize.set(run[0].length, i);
      }
      for (let i = 0; i < markers.length; i += 1) {
        const run = markers[i];
        const start = offset + run.index;
        if (literal[position(start)]) continue;
        if (run[0] === '<!--') {
          if (escaped.has(i)) continue;
          const closing = text.indexOf('-->', start + 4);
          const commentEnd = closing < 0 ? text.length : closing + 3;
          mark(start, commentEnd);
          end = Math.max(end, commentEnd);
          continue;
        }
        const next = nextTick.get(i);
        if (next === undefined) continue;
        mark(start, offset + markers[next].index + markers[next][0].length);
        i = next;
      }
      offset = end;
    }
  }
  const roots: MarkdownDisclosure[] = [];
  const stack: MarkdownDisclosure[] = [];
  let excess = 0;
  let lineStart = 0;
  let scanned = 0;
  let afterTag = 0;
  for (const match of text.matchAll(/<\/?(details|summary)\b/gi)) {
    const start = match.index;
    if (start < afterTag) continue;
    // Advance once through source to retain block position and escape parity.
    for (; scanned < start; scanned += 1) if (text[scanned] === '\n') lineStart = scanned + 1;
    let slashes = 0;
    for (let at = start - 1; at >= 0 && text[at] === '\\'; at -= 1) slashes += 1;
    if (literal[start] || slashes % 2) continue;
    let end = start + match[0].length;
    while (end < text.length && text[end] !== '>') end += 1;
    afterTag = end + 1;
    const written = text.slice(start, afterTag);
    const tag = /^<(\/)?(details|summary)\s*>$/i.exec(written);
    const kind = match[1].toLowerCase();
    const closing = match[0][1] === '/';
    const top = stack.at(-1);
    if (kind === 'details' && !closing) {
      if (excess || stack.length === 32) {
        excess += 1;
        if (top) top.valid = false;
        continue;
      }
      const block = start - lineStart <= 3 && /^ {0,3}$/.test(text.slice(lineStart, start));
      if (!top && !block) continue;
      const node: MarkdownDisclosure = {
        start,
        openingEnd: afterTag,
        end: text.length,
        headingStart: -1,
        headingEnd: -1,
        bodyStart: -1,
        bodyEnd: -1,
        children: [],
        valid: !!tag && block,
      };
      if (top) {
        if (top.bodyStart < 0) top.valid = false;
        top.children.push(node);
      } else roots.push(node);
      stack.push(node);
    } else if (kind === 'details' && closing) {
      if (excess) {
        excess -= 1;
        continue;
      }
      if (!top) continue;
      top.end = afterTag;
      top.bodyEnd = start;
      const tail = text.slice(top.end, text.indexOf('\n', top.end) < 0 ? text.length : text.indexOf('\n', top.end));
      top.valid &&= !!tag && top.bodyStart >= 0 && !tail.trim() && top.children.every((child) => child.valid);
      stack.pop();
    } else if (top && !excess) {
      if (!tag) top.valid = false;
      if (!closing) {
        if (top.headingStart >= 0 || text.slice(top.openingEnd, start).trim()) top.valid = false;
        top.headingStart = afterTag;
      } else {
        if (top.headingStart < 0 || top.headingEnd >= 0 || !text.slice(top.headingStart, start).trim())
          top.valid = false;
        top.headingEnd = start;
        top.bodyStart = afterTag;
      }
    }
  }
  for (const node of stack) node.valid = false;
  return roots;
}

// Read back the visible words emitted by the safe Markdown renderers.
export function visibleTextOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function renderMarkdownBlocks(text: string, renderer: marked.Renderer): string {
  const options = { ...marked.getDefaults(), async: false, gfm: true, breaks: true, mangle: false, renderer };
  if (!/<details\b/i.test(text)) return marked.parse(text, options);
  text = text
    .replace(/\r\n|\r/g, '\n')
    .replace(/^( *)(\t+)/gm, (_, spaces, tabs) => spaces + '    '.repeat(tabs.length));
  const roots = markdownDisclosures(text);
  const lexer = new marked.Lexer(options);
  const fragments = new Map<string, marked.Token[]>();
  const collect = (start: number, end: number, children: MarkdownDisclosure[]): void => {
    let cursor = start;
    for (const child of children) {
      if (!child.valid) continue;
      fragments.set(
        `${cursor}:${child.start}`,
        lexer.blockTokens(text.slice(cursor, child.start).replace(/\r\n|\r/g, '\n'), []),
      );
      collect(child.bodyStart, child.bodyEnd, child.children);
      cursor = child.end;
    }
    fragments.set(`${cursor}:${end}`, lexer.blockTokens(text.slice(cursor, end).replace(/\r\n|\r/g, '\n'), []));
  };
  collect(0, text.length, roots);
  // Resolve queued inline tokens only after every body contributes its reference definitions.
  lexer.lex('');
  const parse = (start: number, end: number) => marked.parser(fragments.get(`${start}:${end}`)!, options);
  const draw = (start: number, end: number, children: MarkdownDisclosure[]): string => {
    let html = '';
    let cursor = start;
    for (const child of children) {
      if (!child.valid) continue;
      html += parse(cursor, child.start);
      const heading = text.slice(child.headingStart, child.headingEnd).trim();
      html += `<details><summary data-disclosure-heading="${escapeHtml(heading)}">${renderInlineMarkdown(heading, lexer.tokens.links)}</summary>`;
      html += draw(child.bodyStart, child.bodyEnd, child.children) + '</details>\n';
      cursor = child.end;
    }
    return html + parse(cursor, end);
  };
  return draw(0, text.length, roots);
}

// The suffixes the panel draws. A reference to anything else names a file the reader can
// open, not a picture, and an image element pointed at one draws a broken box.
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

// Whether a link names a picture, which decides how the editor opens it. The same suffixes
// the panel draws, because a file the panel can draw is a file the editor's own viewer can
// show. A picture handed to the text editor instead is refused, and the reader is told the
// file is missing when it is there.
export function linkTargetIsImage(target: string): boolean {
  return IMAGE_SUFFIX.test(target);
}

// The two controls this module draws for a picture, matched so a link can take them out of
// its own body. Both are written a few lines below, and every value inside them is escaped
// before it is written, so no attribute holds a quote and no label holds a tag.
//
// Markdown has no link inside a link, so a link body holds nothing else of this shape.
const DRAWN_PICTURE = /<button type="button" class="image-link"[^>]*>([\s\S]*?)<\/button>/g;
const DRAWN_REMOTE_PICTURE = /<a href="#" data-link="[^"]*">([\s\S]*?)<\/a>/g;

// One link body, with every control inside it flattened to what it drew.
//
// A link's body is rendered before the link is, so a picture inside one arrives as a control
// already. Neither of them may sit inside an anchor. A button there is invalid and takes a
// tab stop of its own, and an anchor there is closed by the parser at the inner tag, which
// empties the link the response actually wrote.
//
// So the picture stays visible and the link keeps the one press the reader expects.
function insideLink(body: string): string {
  return body.replace(DRAWN_PICTURE, '$1').replace(DRAWN_REMOTE_PICTURE, '$1');
}

// Where one webview loads a picture from, and the file itself for the press that opens it.
// A resource URI belongs to the webview it was made for, so the host builds this per host,
// the same way a file row's icon is built per host.
export interface ResolvedImage {
  src: string;
  path: string;
}

export type ImageResolver = (target: string) => ResolvedImage | null;

// Whether a response names a picture at all.
//
// The host asks this before it renders a summary a second time for one webview. Almost no
// summary names a picture, so the ordinary path pays this test and no parse. It over-reports
// on a literal inside a code fence, which costs one render, and it never under-reports,
// which would leave a broken box on the card.
export function hasImageReference(text: string): boolean {
  return text.includes('![');
}

// A path in a form two spellings can be compared by. Written here rather than taken from
// `transcript.ts`, which reads this module. An import back would be a cycle, and a cycle
// arrives as an undefined export the first time the panel loads.
function comparable(target: string): string {
  const unified = target.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

function within(folder: string, candidate: string): boolean {
  const base = comparable(path.resolve(folder));
  const file = comparable(candidate);
  return file === base || file.startsWith(`${base}/`);
}

// Markdown percent-encodes a space and the renderer hands the encoded form on, so a folder
// whose name holds one would otherwise resolve to no file at all.
function decodedTarget(target: string): string {
  if (!target.includes('%')) {
    return target;
  }
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

// Whether the panel draws this file, and which file it is.
//
// A response is written by the agent, so a path in one is not trusted to point anywhere it
// likes. This is `openLink`'s rule: resolve before testing, because a target that keeps its
// `..` segments passes a prefix test on the unresolved string, and the filesystem then walks
// out of the folder when the file is read.
//
// The test is on the written path. A link inside an open folder still reaches whatever it
// points at, which is what `openLink` does with the same kind of target.
function imageInFolders(written: string, folders: readonly string[]): string | null {
  if (!written || !isLocalLinkPath(written) || !IMAGE_SUFFIX.test(written)) {
    return null;
  }
  const candidates = path.isAbsolute(written)
    ? [path.resolve(written)]
    : folders.map((folder) => path.resolve(folder, written));
  return candidates.find((file) => folders.some((folder) => within(folder, file))) ?? null;
}

// Which file a picture reference in a response names, when the panel draws it at all.
export function imageFileFor(target: string, folders: readonly string[]): string | null {
  return imageInFolders(decodedTarget((target || '').trim()), folders);
}

// The same rule for a path the panel already resolved and the webview sent back on a press.
//
// This one decodes nothing. A per-cent sign reaching here is part of the file's name, and
// decoding it would name a different file: `plan%20b.png` would open `plan b.png`, which is
// either the wrong picture or none at all.
export function imagePathFor(target: string, folders: readonly string[]): string | null {
  return imageInFolders((target || '').trim(), folders);
}

// The file a picture reference names, which is what the panel announces a picture by when
// the response gave it no alt text of its own.
function imageFileName(target: string): string {
  const tail = decodedTarget(target).replace(/\\/g, '/').split('/').pop() || '';
  return tail || 'image';
}

// Markdown for one response, including the safe button used for a local visualization.
// Validated disclosures use generated native tags. Other raw HTML stays escaped. Links keep the data attribute
// the webview already routes through the extension host.
//
// `resolveImage` reports where this webview loads a picture from. Without one, every picture
// draws as the words the response wrote, which is what a caller that has no webview wants.
export function renderRichMarkdown(text: string, resolveImage?: ImageResolver): string {
  if (!text) {
    return '';
  }
  try {
    const renderer = new marked.Renderer();
    renderer.html = (html: string) => escapeHtml(html);
    // A picture the reader can see, and press to open full size in the editor. Three cases,
    // and only the first draws a picture. A remote address draws a link instead: a response
    // is agent content, and fetching a picture as the card renders would tell that server
    // the reader opened the panel. Anything else keeps the words the response wrote.
    renderer.image = (href: string | null, title: string | null, alt: string) => {
      const target = href || '';
      // The renderer escapes `alt` and `title` before it hands them here, so both go into
      // an attribute as they are. Escaping either a second time would draw `&quot;` as five
      // characters. The address and the file name are this module's own, so it escapes them.
      const written = (alt || '').replace(/\s+/g, ' ').trim();
      const label = written || escapeHtml(imageFileName(target));
      if (/^https?:\/\//i.test(target)) {
        return `<a href="#" data-link="${escapeHtml(target)}">${label}</a>`;
      }
      const picture = resolveImage ? resolveImage(target) : null;
      if (!picture) {
        return label;
      }
      // The alt text is what the browser draws in place of a picture that has gone, so the
      // words stay on the card without a handler. The button carries the action a screen
      // reader reads, which the alt text alone does not say.
      return (
        `<button type="button" class="image-link"` +
        ` data-image="${escapeHtml(picture.path)}"` +
        ` aria-label="Open image: ${label}"` +
        (title ? ` title="${title}"` : '') +
        `><img src="${escapeHtml(picture.src)}" alt="${label}"></button>`
      );
    };
    renderer.link = (href: string, title: string | null | undefined, body: string) => {
      const visualization = visualizationPath(href || '');
      if (visualization) {
        return (
          `<button type="button" class="editor-link visualization-link"` +
          ` data-visualization="${escapeHtml(visualization)}">${body}</button>`
        );
      }
      // `title` reaches here already escaped, the way the alt text above does.
      return (
        `<a href="#" data-link="${escapeHtml(href || '')}"` +
        (title ? ` title="${title}"` : '') +
        `>${insideLink(body)}</a>`
      );
    };
    // `mangle: false`: marked 4's default obfuscates an autolinked email address behind
    // random numeric character references, which differ on every call over the same text.
    // The rendered response is redrawn on refresh, so an email in it would redraw with
    // nothing visibly changed.
    return renderMarkdownBlocks(richMarkdown(text), renderer);
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

// One line of inline Markdown, for a surface that draws no block content and takes no
// pointer press of its own. Raw HTML stays escaped the same way `renderRichMarkdown` escapes
// it. A link draws its body text with no anchor, and a picture draws its alt text, or its
// file name where it has none, with no `img` and no button: the folded card's headline is not
// itself interactive, and a link or a picture inside it would add a tab stop to every folded
// card for a press the headline has no way to act on.
export function renderInlineMarkdown(text: string, links?: marked.TokensList['links']): string {
  if (!text) {
    return '';
  }
  try {
    const renderer = new marked.Renderer();
    renderer.html = (html: string) => escapeHtml(html);
    renderer.link = (_href: string | null, _title: string | null | undefined, body: string) => body;
    renderer.image = (href: string | null, _title: string | null, alt: string) => {
      const written = (alt || '').replace(/\s+/g, ' ').trim();
      return written || escapeHtml(imageFileName(href || ''));
    };
    // `mangle: false`: marked 4's default obfuscates an autolinked email address behind
    // random numeric character references, which differ on every call over the same text.
    // `headlineHtml` sits in the card view payload that decides whether a card redraws, so a
    // headline with an email in it would redraw on every refresh with nothing visibly changed.
    const options = { ...marked.getDefaults(), async: false, gfm: true, mangle: false, renderer };
    if (!links) return marked.parseInline(text, options);
    const lexer = new marked.Lexer(options);
    lexer.tokens.links = links;
    return marked.Parser.parseInline(lexer.inlineTokens(text), options);
  } catch {
    return escapeHtml(text);
  }
}
