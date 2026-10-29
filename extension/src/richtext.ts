// Rich content references recorded inside assistant text.
//
// Some clients save rich-content instructions and draw them as interactive controls.
// The timeline retains the original summary. Only the Markdown renderer receives translated text.

import * as path from 'path';
import { marked } from 'marked';
import { isLocalLinkPath } from './domain/link-path';
import { maskedCitationSource, nativeCitationPath } from './domain/file-citation';
import { parseSessionLink } from './domain/session-link';
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

// Replaces visualization lines with Markdown links for the timeline.
// Fenced examples stay literal. Malformed references produce an unavailable message
// without exposing private-use control characters.
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

function markdownContainerPositions(raw: string, body: string, start: number, position: (index: number) => number) {
  // Marked removes container prefixes, task markers, and final whitespace.
  // Match each remaining line's suffix to retain positions in the original source.
  body = body.replace(/^( *)(\t+)/gm, (_, spaces, tabs) => spaces + '    '.repeat(tabs.length));
  const rawLines = raw.split('\n');
  const bodyLines = body.split('\n');
  const positions: number[] = [];
  let rawOffset = start;
  for (let line = 0; line < bodyLines.length; line += 1) {
    const content = bodyLines[line].trimStart();
    const head = bodyLines[line].length - content.length;
    const contentStart = rawLines[line].lastIndexOf(content);
    for (let index = 0; index < bodyLines[line].length; index += 1) {
      positions.push(position(rawOffset + Math.max(0, contentStart - head + index)));
    }
    if (line < bodyLines.length - 1) positions.push(position(rawOffset + rawLines[line].length));
    rawOffset += rawLines[line].length + 1;
  }
  return { text: body, positions };
}

// Consume directives and existing Markdown protection in source order.
// Emphasis and tables run only after eligible interiors become opaque.
function visitCitationMarkdown(text: string, consume: (start: number) => number): void {
  const tokenizer = new marked.Tokenizer() as marked.Tokenizer & marked.TokenizerThis;
  const lexer = new marked.Lexer({ gfm: true, breaks: true, tokenizer });
  tokenizer.lexer = lexer;
  // Preserve Marked's inline queue for block-token merges. Skip inline parsing.
  lexer.inlineTokens = (_source, tokens = []) => tokens;
  lexer.blockTokens(text, []);
  // Marked's declaration names an array here, but its runtime accepts the link registry.
  const reflink = tokenizer.reflink as unknown as (
    source: string,
    links: marked.TokensList['links'],
  ) => marked.Token | undefined;
  const pending: { text: string; positions: number[] | null; offset: number }[] = [
    { text, positions: null, offset: 0 },
  ];
  let consumed = 0;
  while (pending.length) {
    const frame = pending.at(-1)!;
    const { text, positions } = frame;
    const position = (index: number): number => (positions ? positions[index] : index);
    if (frame.offset >= text.length) {
      pending.pop();
      continue;
    }
    if (position(frame.offset) < consumed) {
      do frame.offset += 1;
      while (frame.offset < text.length && position(frame.offset) < consumed);
      continue;
    }
    const offset = frame.offset;
    const source = text.slice(offset);
    const block = tokenizer.space(source) ?? tokenizer.fences(source) ?? tokenizer.code(source);
    if (block) {
      frame.offset += block.raw.length;
      continue;
    }
    const disclosure = /^ {0,3}<\/?(?:details|summary)\b[^>]*>/i.exec(source);
    if (disclosure) {
      frame.offset += disclosure[0].length;
      continue;
    }
    const quote = tokenizer.blockquote(source);
    if (quote) {
      frame.offset += quote.raw.length;
      pending.push({ ...markdownContainerPositions(quote.raw, quote.text, offset, position), offset: 0 });
      continue;
    }
    const list = tokenizer.list(source);
    if (list) {
      frame.offset += list.raw.length;
      let itemOffset = offset;
      const items = list.items.map((item) => {
        const mapped = { ...markdownContainerPositions(item.raw, item.text, itemOffset, position), offset: 0 };
        itemOffset += item.raw.length;
        return mapped;
      });
      for (let index = items.length - 1; index >= 0; index -= 1) pending.push(items[index]);
      continue;
    }
    const protectedBlock = tokenizer.html(source) ?? tokenizer.def(source);
    if (protectedBlock) {
      frame.offset += protectedBlock.raw.length;
      continue;
    }
    const raw = (tokenizer.paragraph(source) ?? tokenizer.text(source)).raw;
    frame.offset += raw.length;
    const syntax = /:+|\\|`+|<|!?\[/g;
    for (let match = syntax.exec(raw); match; match = syntax.exec(raw)) {
      const start = offset + match.index;
      if (position(start) < consumed) continue;
      const tail = raw.slice(match.index);
      if (match[0][0] === ':' && !lexer.state.inLink && !lexer.state.inRawBlock) {
        const end = consume(position(start));
        if (end > position(start)) {
          consumed = end;
          let next = match.index + 1;
          while (next < raw.length && position(offset + next) < end) next += 1;
          syntax.lastIndex = next;
          continue;
        }
      }
      const character = match[0][0];
      const token =
        character === '\\'
          ? tokenizer.escape(tail)
          : character === '<'
            ? (tokenizer.tag(tail) ?? tokenizer.autolink(tail, (value) => value))
            : character === '`'
              ? tokenizer.codespan(tail)
              : character === '[' || character === '!'
                ? (tokenizer.link(tail) ?? reflink.call(tokenizer, tail, lexer.tokens.links))
                : undefined;
      if (token) syntax.lastIndex = match.index + token.raw.length;
      else if (tail.startsWith('<!--')) {
        const close = text.indexOf('-->', start + 4);
        consumed = close < 0 ? position(text.length - 1) + 1 : position(close + 2) + 1;
        frame.offset = Math.max(frame.offset, close < 0 ? text.length : close + 3);
        break;
      }
    }
  }
}

function markdownLiteralRanges(
  text: string,
  onCode?: (start: number, end: number, text: string, language?: string) => void,
): Uint8Array {
  const literal = new Uint8Array(text.length);
  const pending: { text: string; positions: number[] | null }[] = [{ text, positions: null }];
  while (pending.length) {
    let { text, positions } = pending.pop()!;
    // Marked expands leading tabs before recognizing block containers.
    // Each expanded space retains the tab's original source position.
    if (/^ *\t/m.test(text)) {
      const originalPositions = positions;
      const normalizedPositions: number[] = [];
      let offset = 0;
      const copyUntil = (end: number): void => {
        for (; offset < end; offset += 1) normalizedPositions.push(originalPositions?.[offset] ?? offset);
      };
      const normalized = text.replace(/^( *)(\t+)/gm, (_match, spaces: string, tabs: string, start: number) => {
        copyUntil(start + spaces.length);
        for (let tab = 0; tab < tabs.length; tab += 1, offset += 1) {
          const position = originalPositions?.[offset] ?? offset;
          normalizedPositions.push(position, position, position, position);
        }
        return spaces + '    '.repeat(tabs.length);
      });
      copyUntil(text.length);
      text = normalized;
      positions = normalizedPositions;
    }
    const position = (index: number): number => (positions ? positions[index] : index);
    const mark = (start: number, end: number): void => {
      if (!positions) literal.fill(1, start, end);
      else for (let index = start; index < end; index += 1) literal[positions[index]] = 1;
    };
    const container = (raw: string, body: string, start: number): void => {
      pending.push(markdownContainerPositions(raw, body, start, position));
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
        if (block.type === 'code') {
          mark(offset, offset + block.raw.length);
          onCode?.(position(offset), position(offset + block.raw.length - 1) + 1, block.text, block.lang);
        }
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
  return literal;
}

// Code blocks retain their original extents and text without list or blockquote prefixes.
export function markdownCodeBlocks(text: string): { start: number; end: number; text: string; language?: string }[] {
  const blocks: { start: number; end: number; text: string; language?: string }[] = [];
  markdownLiteralRanges(text, (start, end, text, language) => blocks.push({ start, end, text, language }));
  return blocks.sort((a, b) => a.start - b.start);
}

// Match structure before Markdown lexing, which otherwise consumes tight bodies as HTML.
// Literal regions never supply tags. The disclosure depth bounds rendering and disclosure stack storage.
function markdownDisclosures(text: string): MarkdownDisclosure[] {
  const literal = markdownLiteralRanges(text);
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
export function visibleTextOf(html: string, singlePass = false): string {
  const text = html.replace(/<[^>]*>/g, '');
  if (singlePass) {
    // One pass preserves entity examples that the literal renderer escaped as source text.
    return text.replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]!,
    );
  }
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

interface CitationExtensions {
  inline: Array<
    (this: marked.TokenizerThis, source: string, tokens: marked.Token[]) => marked.Tokens.Generic | undefined
  >;
  renderers: Record<string, (token: marked.Tokens.Generic) => string>;
}

function renderMarkdownBlocks(
  text: string,
  renderer: marked.Renderer,
  extensions?: CitationExtensions,
  tokenizer?: marked.Tokenizer,
): string {
  const options = {
    ...marked.getDefaults(),
    async: false,
    gfm: true,
    breaks: true,
    mangle: false,
    renderer,
    extensions,
    tokenizer,
  };
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

// Identifies image targets using the same suffixes the panel renders.
// The editor opens those targets in its image viewer.
// Opening them as text can produce a missing-file message even when the file exists.
export function linkTargetIsImage(target: string): boolean {
  return IMAGE_SUFFIX.test(target);
}

// Matches picture controls so an enclosing link can retain their content alone.
// Generated attributes and labels are escaped, so quotes and tags cannot change the match.
// Markdown link bodies cannot contain another Markdown link.
const DRAWN_PICTURE = /<button type="button" class="image-link"[^>]*>([\s\S]*?)<\/button>/g;
const DRAWN_REMOTE_PICTURE = /<a href="#" data-link="[^"]*">([\s\S]*?)<\/a>/g;

// Flattens picture controls inside a link body while retaining their visible content.
// The renderer processes the body before the enclosing link.
// A nested button adds an invalid tab stop. A nested anchor closes the outer anchor early.
// Flattening keeps the picture visible and leaves one link action.
function insideLink(body: string): string {
  return body.replace(DRAWN_PICTURE, '$1').replace(DRAWN_REMOTE_PICTURE, '$1');
}

// The image resource URI for one webview and the file path its open action uses.
// Resource URIs belong to their creating webview, so each host resolves its own images.
export interface ResolvedImage {
  src: string;
  path: string;
}

export type ImageResolver = (target: string) => ResolvedImage | null;

// Detects possible Markdown image references before webview-specific rendering.
// A code-fence example can cause an extra render.
// Every Markdown image reference includes this marker, so the check cannot omit an image.
export function hasImageReference(text: string): boolean {
  return text.includes('![');
}

// Normalizes paths for comparison, ignoring case on Windows.
// `transcript.ts` imports this module, so importing its path helper would create a cycle.
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

// Resolves local image paths within the open folders.
// Resolve `..` before comparing prefixes.
// Comparing an unresolved prefix can admit a file outside the folder.
// The check uses the written path. A symlink inside a folder can point outside it.
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

// Checks a resolved image path returned by the webview.
// Percent signs remain literal because decoding can change the filename.
// For example, `plan%20b.png` and `plan b.png` name different files.
export function imagePathFor(target: string, folders: readonly string[]): string | null {
  return imageInFolders((target || '').trim(), folders);
}

// The file a picture reference names, which is what the panel announces a picture by when
// the response gave it no alt text of its own.
function imageFileName(target: string): string {
  const tail = decodedTarget(target).replace(/\\/g, '/').split('/').pop() || '';
  return tail || 'image';
}

// Renders response Markdown with validated disclosures and local visualization buttons. Other raw HTML stays escaped.
// Links carry data-link for host routing. Without resolveImage, pictures render as text.
export function renderRichMarkdown(text: string, resolveImage?: ImageResolver, inert = false): string {
  if (!text) {
    return '';
  }
  try {
    const original = inert ? text : richMarkdown(text);
    const masked = maskedCitationSource(original, (consume) => visitCitationMarkdown(original, consume));
    const source = masked.text;
    const names = new Map<string, Set<string>>();
    const citations: CitationExtensions = {
      inline: [
        function (source, tokens) {
          if (this.lexer.state.inLink || this.lexer.state.inRawBlock) return undefined;
          const marker = source.slice(0, 10);
          const candidate = masked.directives.get(marker);
          if (!candidate) return undefined;
          const directive = candidate.directive;
          if (!directive || (tokens.at(-1)?.type === 'escape' && tokens.at(-1)?.raw === '\\:'))
            return { type: 'fileCitation', raw: marker };
          const file =
            directive.name === 'codex-file-citation'
              ? nativeCitationPath(directive.attributes.get('path') || '', process.platform)
              : null;
          if (!file) return { type: 'fileCitation', raw: marker };
          const name = (process.platform === 'win32' ? path.win32.basename(file) : path.posix.basename(file)) || file;
          const peers = names.get(name) ?? new Set<string>();
          peers.add(file);
          names.set(name, peers);
          return { type: 'fileCitation', raw: marker, file, name, purpose: directive.attributes.get('purpose') };
        },
      ],
      renderers: {
        fileCitation: (token) => {
          if (!token.file) return escapeHtml(token.raw);
          const purpose = token.purpose === 'source' ? 'Source: ' : token.purpose === 'output' ? 'Output: ' : '';
          if (inert) return escapeHtml(purpose + token.file);
          const label = escapeHtml(purpose + (names.get(token.name)!.size > 1 ? token.file : token.name));
          return `<a href="#" data-link="${escapeHtml(token.file)}" data-link-kind="file-citation" title="${escapeHtml(token.file)}" aria-label="${escapeHtml(purpose + token.file)}">${label}</a>`;
        },
      },
    };
    const tokenizer = new marked.Tokenizer() as marked.Tokenizer & marked.TokenizerThis;
    if (masked.directives.size > 0) {
      const inlineText = tokenizer.inlineText;
      const textRule = ((marked.Lexer.rules.inline as marked.Rules).breaks as marked.Rules).text as RegExp;
      // Add the mask delimiter to Marked's text boundaries without changing its URL or email rules.
      const citationText = new RegExp(textRule.source.replace('|$)', '|\uE000|$)'), textRule.flags);
      tokenizer.inlineText = function (source, smartypants) {
        const matched = citationText.exec(source);
        return inlineText.call(this, matched?.[0] ?? '', smartypants);
      };
    }
    const renderer = new marked.Renderer();
    renderer.html = (html: string) => escapeHtml(html);
    // Renders local images with an open action. Remote image addresses render as links.
    // Loading remote images during card rendering would disclose panel access to that server.
    // Unresolved images retain their label text.
    renderer.image = (href: string | null, title: string | null, alt: string) => {
      if (inert) return escapeHtml(alt || 'Image omitted');
      const target = href || '';
      // Marked supplies escaped `alt` and `title` values for direct attribute insertion.
      // Escaping them again would display `&quot;` literally.
      // This module escapes the address and fallback filename itself.
      const written = (alt || '').replace(/\s+/g, ' ').trim();
      const label = written || escapeHtml(imageFileName(target));
      if (/^https?:\/\//i.test(target)) {
        return `<a href="#" data-link="${escapeHtml(target)}">${label}</a>`;
      }
      const picture = resolveImage ? resolveImage(target) : null;
      if (!picture) {
        return label;
      }
      // Alt text remains visible if the image fails to load.
      // The button accessible name identifies the open action.
      return (
        `<button type="button" class="image-link"` +
        ` data-image="${escapeHtml(picture.path)}"` +
        ` aria-label="Open image: ${label}"` +
        (title ? ` title="${title}"` : '') +
        `><img src="${escapeHtml(picture.src)}" alt="${label}"></button>`
      );
    };
    renderer.link = (href: string, title: string | null | undefined, body: string) => {
      if (inert) return body;
      const sessionLink = parseSessionLink(href || '');
      if (sessionLink.kind === 'invalid') return insideLink(body);
      if (sessionLink.kind === 'session') {
        const label = insideLink(body);
        return `<a href="#" data-link="${escapeHtml(href)}" aria-label="Open session: ${label.replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}">${label}</a>`;
      }
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
    // renderMarkdownBlocks disables random email mangling so unchanged responses keep stable HTML.
    const html = renderMarkdownBlocks(source, renderer, citations, tokenizer);
    return html.replace(/\uE000[0-9a-f]{8}\uE001/g, (marker) => {
      const candidate = masked.directives.get(marker);
      return candidate ? escapeHtml(candidate.raw) : marker;
    });
  } catch {
    return `<pre>${escapeHtml(text)}</pre>`;
  }
}

// Renders inline text without raw HTML, image elements, or buttons.
// Session and external anchors require explicit opt-in. Literal mode changes only eligible external link tokens.
export function renderInlineMarkdown(
  text: string,
  links?: marked.TokensList['links'],
  inline: { sessionLinks?: boolean; externalLinks?: boolean; literal?: boolean; literalEntities?: boolean } = {},
): string {
  if (!text) {
    return '';
  }
  try {
    const renderer = new marked.Renderer();
    renderer.html = (html: string) => escapeHtml(html);
    if (inline.literalEntities) renderer.text = (text: string) => escapeHtml(visibleTextOf(text, true));
    renderer.link = (href: string | null, _title: string | null | undefined, body: string) => {
      const label = insideLink(body);
      if (inline.externalLinks && /^https?:\/\//i.test(href || '')) {
        return `<a href="#" data-link="${escapeHtml(href || '')}">${label}</a>`;
      }
      if (!inline.sessionLinks || parseSessionLink(href || '').kind !== 'session') return body;
      return `<a href="#" data-link="${escapeHtml(href || '')}" aria-label="Open session: ${label.replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}">${label}</a>`;
    };
    renderer.image = (href: string | null, _title: string | null, alt: string) => {
      const written = (alt || '').replace(/\s+/g, ' ').trim();
      return written ? renderer.text(written) : escapeHtml(imageFileName(href || ''));
    };
    const tokenizer = new marked.Tokenizer() as marked.Tokenizer & marked.TokenizerThis;
    if (inline.literalEntities) {
      const inlineText = tokenizer.inlineText;
      tokenizer.inlineText = function (source, smartypants) {
        const token = inlineText.call(this, source, smartypants);
        if (token) token.text = escapeHtml(token.raw);
        return token;
      };
    }
    if (inline.externalLinks) {
      const autolink = tokenizer.autolink;
      tokenizer.autolink = function (source, mangle) {
        const token = autolink.call(this, source, mangle);
        // Marked escapes angle-autolink destinations before the renderer receives them.
        if (token && /^https?:\/\//i.test(token.href)) token.href = visibleTextOf(token.href, true);
        return token;
      };
      if (!inline.literal) {
        const escape = tokenizer.escape;
        tokenizer.escape = function (source) {
          const token = escape.call(this, source);
          // Consume a complete escaped example before GFM recognizes its destination as a bare URL.
          const example = token?.raw === '\\[' ? this.link(source.slice(1)) : undefined;
          return example ? { type: 'escape', raw: '\\' + example.raw, text: escapeHtml(example.raw) } : token;
        };
      }
    }
    // Disable random email character references so unchanged headlines retain stable HTML.
    // All bare URLs stay literal in literal mode, including URLs inside escaped Markdown examples.
    const options = { ...marked.getDefaults(), async: false, gfm: !inline.literal, mangle: false, renderer, tokenizer };
    if (!links && !inline.literal) return marked.parseInline(text, options);
    const lexer = new marked.Lexer(options);
    if (links) lexer.tokens.links = links;
    const tokens = lexer.inlineTokens(text);
    if (!inline.literal) return marked.Parser.parseInline(tokens, options);
    const literalTokens = (tokens: marked.Token[]): string =>
      tokens
        .map((token) => {
          if (token.type === 'link') {
            const label = token.raw.startsWith('<') ? visibleTextOf(token.text, true) : token.text;
            return inline.externalLinks && /^https?:\/\//i.test(token.href || '')
              ? renderer.link(token.href, null, escapeHtml(label))
              : escapeHtml(token.raw);
          }
          if ('tokens' in token && token.tokens) {
            let offset = 0;
            let html = '';
            for (const child of token.tokens) {
              const start = token.raw.indexOf(child.raw, offset);
              html += escapeHtml(token.raw.slice(offset, start)) + literalTokens([child]);
              offset = start + child.raw.length;
            }
            return html + escapeHtml(token.raw.slice(offset));
          }
          return escapeHtml(token.raw);
        })
        .join('');
    return literalTokens(tokens);
  } catch {
    return escapeHtml(text);
  }
}
