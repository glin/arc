// What the panel's tones measure against the grounds they are drawn on.
//
// The stylesheet keeps its colours in custom properties, and a reader can only read a word
// when the tone and the ground behind it are far enough apart. This module answers that in
// numbers. It reads the stylesheet and a theme table as text, so it holds no second copy of
// either and cannot drift from what ships.
//
// Two things use it. `panel.webview.test.ts` fails when a tone that carries a word falls
// under 4.5 to 1 without a recorded exception. The panel-mockup skill draws the tone sheet
// from it, so a mockup argues about a measured figure rather than about an impression.
//
// Every figure anyone states about a tone comes from here. Working one out by hand rounds the
// chip mix per channel where `color-mix` does not, which lands a hundredth away from what the
// guard reads, and a figure copied into a comment is a second source that drifts on its own.

/* The grounds a card or a chip can sit on: the panel background, the sidebar-toned control
   bar, a hovered row, and the row a card sits on selected but unfocused. */
export const BACKGROUNDS = {
  dark: ['#1f1f1f', '#181818', '#2a2d2e', '#37373d'],
  light: ['#ffffff', '#f8f8f8', '#f2f2f2', '#e4e6f1'],
} as const;

export type ThemeKind = keyof typeof BACKGROUNDS;

/* Which of the four above only one row wears at a time, by position: the row under the
   pointer, and the row a card sits on selected but unfocused. Two cards share the panel and
   they share the control bar, and they can never share these, so a pair of tones is never
   read with both of its words over one of them.

   A position and not a colour. A colour is a spelling, and the same spelling is a hovered
   row in one theme and an ordinary panel in another, so reading the role off the value gets
   both directions wrong. */
export const SOLE_GROUNDS: readonly number[] = [2, 3];

/* A tone whose own tinted chip reads worse than any plain ground it is also drawn on, and
   the percentage that chip's rule mixes into the ground behind it. `--warn`, `--full` and
   `--notice` share the three-band context-figure chip. `--mod` has the new-draft chip.
   `--ok` is the answered value and the answered mark on a request card's tab, which draws on
   `--chipbg`.

   `--chipbg` is the one of the five that tints with the editor's foreground rather than with
   the tone drawn inside it, so the figure taken here is close to the pixel rather than equal
   to it. It reads worse than the plain panel either way, which is what this table is for. */
export const CHIP_MIX: Readonly<Partial<Record<string, number>>> = {
  warn: 18,
  full: 26,
  notice: 12,
  mod: 18,
  ok: 9,
};

/* A tone the scan finds that is not a status word, and why the 4.5 a word needs does not
   apply to it. `--idle` is the editor's own de-emphasised text and is listed here too, so
   the guard and the tone sheet skip the same set. */
export const EXCLUDED_TONES: Readonly<Record<string, string>> = {
  // .sbsep draws a literal separator between two status-bar figures. It is a mark between
  // two words, not a word of its own, the way a border or a bullet is not text either.
  edge: 'draws the status bar separator mark, not a word',
  // panel.css leaves --idle on var(--vscode-descriptionForeground) rather than a literal:
  // it is the editor's own de-emphasised text, drawn at the same weight through the chrome
  // around the panel, and a literal here would make the panel disagree with its window.
  idle: "the editor's own colour for text nobody is meant to read first",
};

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/* A hex or rgb value as numbers. A tone can carry alpha, which is the whole reason the
   stylesheet must never read a graph token: charts.orange is orange at a third opacity. */
export function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
      a: hex[2] ? parseInt(hex[2], 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/.exec(value.trim());
  if (!rgb) {
    throw new Error(`this measurement cannot read the colour "${value}"`);
  }
  return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] ? Number(rgb[4]) : 1 };
}

export function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/* One colour drawn over another, at the first one's own alpha. */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  };
}

/* The WCAG ratio of a tone over a ground. Both are composited before their luminance is
   read, so a translucent tone is measured at the strength it draws.

   A ground can be translucent too, and several themes ship one: a hover row is often a
   percentage of white laid over whatever is behind it. Contrast is a property of the pixel,
   not of the declaration, so a translucent ground is laid over `base` first. Read as written,
   a ground of `#ffffff14` measures as pure white and reports a readable word as hopeless.

   `base` is the panel background. The webview's own body is transparent, so the true base is
   whatever the editor paints behind the frame, and the panel background is the closest thing
   the stylesheet can name. */
export function contrastOn(fg: string, bg: string, base = '#000000'): number {
  const ground = parseColor(bg);
  const solid = ground.a < 1 ? over(ground, parseColor(base)) : ground;
  const text = over(parseColor(fg), solid);
  const lighter = Math.max(luminance(text), luminance(solid));
  const darker = Math.min(luminance(text), luminance(solid));
  return (lighter + 0.05) / (darker + 0.05);
}

export function worstOf(fg: string, grounds: readonly string[], base?: string): number {
  return Math.min(...grounds.map((bg) => contrastOn(fg, bg, base)));
}

/* The same figure for a tone drawn inside a chip whose own background is that tone mixed at
   a set percentage into the ground the chip sits on. Tinting a ground with the text's own
   hue pulls the two together, so this reads worse than the plain ground underneath. */
export function chipWorstOf(fg: string, grounds: readonly string[], mixPercent: number, base = '#000000'): number {
  const f = parseColor(fg);
  const p = mixPercent / 100;
  return Math.min(
    ...grounds.map((bg) => {
      const raw = parseColor(bg);
      const b = raw.a < 1 ? over(raw, parseColor(base)) : raw;
      // color-mix carries the tone's own alpha into the result, so a tone at a third opacity
      // mixed at 26% tints the ground by about 9% and not by 26%. Reading the mix as opaque
      // reports a chip far louder than the one the browser draws.
      const tint = p * f.a;
      const ground =
        `rgb(${tint * f.r + (1 - tint) * b.r}, ${tint * f.g + (1 - tint) * b.g}, ` +
        `${tint * f.b + (1 - tint) * b.b})`;
      return contrastOn(fg, ground);
    }),
  );
}

/* One top-level stylesheet rule's declarations, found by its exact selector list. Exact,
   because the stylesheet is one namespace and the interesting selectors are prefixes of each
   other. Top-level, because a rule inside `@media` or `@supports` applies only some of the
   time. The selector list is compared with its whitespace in one shape, so line breaks and
   indentation do not change which rule is read. */
export function ruleBody(styleSource: string, selector: string): string {
  const source = withoutComments(styleSource);
  const wanted = selectorList(selector);
  const bodies: string[] = [];
  // Every rule with this selector, in the order they are written. A stylesheet may declare
  // one twice, and the browser reads both, so a reader that stops at the first reports a
  // value the second one replaced.
  let depth = 0;
  let prelude = 0;
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at];
    if (character === '"' || character === "'") {
      while (at + 1 < source.length && source[at + 1] !== character) at += source[at + 1] === '\\' ? 2 : 1;
      at += 1;
    } else if (character === '{') {
      if (depth === 0 && selectorList(source.slice(prelude, at)) === wanted) {
        const close = source.indexOf('}', at);
        if (close === -1) {
          throw new Error(`the "${selector}" rule has no closing brace`);
        }
        bodies.push(source.slice(at + 1, close));
      }
      depth += 1;
    } else if (character === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) prelude = at + 1;
    } else if (character === ';' && depth === 0) {
      prelude = at + 1;
    }
  }
  if (!bodies.length) {
    throw new Error(`the stylesheet has no "${selector}" rule`);
  }
  return bodies.join('\n');
}

/* A selector list with its whitespace in one shape: one space between words, and `, ` between
   the selectors of the list. */
function selectorList(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/ ?, ?/g, ', ');
}

/* The stylesheet with every comment blanked to spaces. A declaration written inside a comment
   is not a declaration, and the browser draws nothing from it, so anything reading this file
   for what ships has to be blind to it the same way. A `}` inside one would end a rule early
   as well. Blanked and not deleted, so every offset still points at the same character. */
function withoutComments(styleSource: string): string {
  return styleSource.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

/* What a real editor hands the page for a token a declaration reads, so a declaration left
   on var(--vscode-charts-orange, #d18616) is measured at the alpha value the editor sends
   and not at the opaque fallback written for a broken host. */
export function resolveValue(raw: string, theme: string): string {
  const asVar = /^var\((--vscode-[\w-]+)(?:,\s*(.+))?\)$/.exec(raw.trim());
  if (!asVar) {
    return raw.trim();
  }
  const [, name, fallback] = asVar;
  const found = new RegExp(`${name}:([^;]+);`).exec(theme);
  if (found) {
    return found[1].trim();
  }
  if (!fallback) {
    throw new Error(`panel.css reads ${name} with no fallback, and the theme table does not set it either`);
  }
  return resolveValue(fallback, theme);
}

/* Every custom property the stylesheet paints text with, read from the stylesheet rather
   than from a list kept here: a tone added later and never taught to a caller would
   otherwise carry text and never be asked about. */
export function textToneNames(styleSource: string): string[] {
  const names = new Set<string>();
  const re = /(?<![\w-])color:\s*var\(--(?!vscode-)([\w-]+)\)/g;
  let found: RegExpExecArray | null;
  while ((found = re.exec(styleSource))) {
    names.add(found[1]);
  }
  return [...names].sort();
}

/* Every selector that paints text with a given tone, keyed by tone name. A tone sheet says
   where a tone is drawn as well as how it measures, and reading the selectors back out of
   the stylesheet keeps that list from going stale the way a written one does. */
export function toneUsages(styleSource: string): Record<string, string[]> {
  const usages: Record<string, string[]> = {};
  // Blanked first, so a rule someone commented out is not read as a rule that ships. The
  // browser draws nothing from it, and reading it makes this claim a tone is painted where
  // nothing is painted at all.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let rule: RegExpExecArray | null;
  while ((rule = re.exec(withoutComments(styleSource)))) {
    const selector = rule[1].replace(/\s+/g, ' ').trim();
    if (!selector) {
      continue;
    }
    // A fallback after the name is ordinary CSS and this stylesheet writes several, so the
    // name ends at a comma as well as at the closing bracket. Read only to the bracket, a
    // rule painting `var(--paused, #654321)` is a rule this reports as painting nothing.
    const inner = /(?<![\w-])color:\s*var\(--(?!vscode-)([\w-]+)\s*[,)]/g;
    let paint: RegExpExecArray | null;
    while ((paint = inner.exec(rule[2]))) {
      const list = (usages[paint[1]] ??= []);
      if (!list.includes(selector)) {
        list.push(selector);
      }
    }
  }
  return usages;
}

/* A theme to measure in: its variable table, which of the editor's two kinds it is, and the
   four grounds a card sits on inside it. A theme the reader installed has its own grounds,
   so they are given rather than assumed. Left out, the kind's own defaults answer. */
export interface ThemeInput {
  id: string;
  kind: ThemeKind;
  table: string;
  grounds?: readonly string[];
  /* Which of those grounds only one row wears at a time, by position. Left out with the
     grounds, `SOLE_GROUNDS` answers for the kind's own four. Left out beside a ground list
     of the caller's own, nothing is sole: the roles in that list are the caller's to state,
     and guessing them from the colour values is how both directions go wrong. */
  soleGrounds?: readonly number[];
  /* What a translucent ground is laid over. Defaults to the first ground, which is the panel
     background in every theme shipped here. A caller whose ground list does not lead with an
     opaque panel colour says so here rather than relying on that order. */
  base?: string;
}

export interface ToneReading {
  tone: string;
  /* The theme this reading was taken in, which is the id given for it. */
  theme: string;
  kind: ThemeKind;
  /* The value the editor resolves the declaration to, after any token and any fallback. */
  value: string;
  /* The chip mix the figure was taken through, or null when the tone is drawn on the plain
     panel. */
  chipMix: number | null;
  /* The worst ratio over the four grounds, which is the one that decides the tone. */
  worst: number;
}

export interface ToneDistance {
  /* The two tone names, in the order `STATUS_TONES` lists them. */
  pair: string;
  theme: string;
  kind: ThemeKind;
  /* The two resolved values the distance was taken between. */
  values: [string, string];
  /* The ground each of the two was drawn over where the pair sits closest. They differ when
     one card is hovered or selected and the card being compared with it is not. */
  grounds: [string, string];
  /* CIEDE2000, at those grounds. */
  distance: number;
}

/* Which block declares a tone for a given kind. `--ok`, `--bad`, `--busy` and `--need` are
   overridden for light. Every other tone is declared once, in `:root`. */
export const DARK_BLOCK = ':root';
export const LIGHT_BLOCK = 'body.vscode-light, body.vscode-high-contrast-light';

export function toneValue(styleSource: string, theme: string, tone: string, kind: ThemeKind): string {
  const dark = ruleBody(styleSource, DARK_BLOCK);
  const light = ruleBody(styleSource, LIGHT_BLOCK);
  // The one the browser draws. An important declaration beats every ordinary one whatever
  // the order, and among equals the last wins. A reader that takes the first reports a colour
  // nothing on screen carries. Bounded on the left so `--warn` is not found inside
  // `--warning`.
  const declared = (block: string): string | undefined => {
    const all = [...block.matchAll(new RegExp(`(?:^|[^\\w-])--${tone}\\s*:\\s*([^;]+);`, 'g'))].map((found) =>
      found[1].trim(),
    );
    const important = all.filter((value) => /!\s*important$/i.test(value));
    return (important.length ? important : all).pop()?.replace(/\s*!\s*important$/i, '');
  };
  const found = (kind === 'light' ? declared(light) : undefined) ?? declared(dark);
  if (found === undefined) {
    throw new Error(`panel.css no longer sets --${tone}`);
  }
  return resolveValue(found, theme);
}

/* The tones a reader is asked to tell one from another, rather than only to read against
   the panel. A card says running where another says needs you, and a turn says failed where
   another says done. A ratio against a ground says a word is legible and says nothing about
   whether it is the word beside it.

   The list is written out, and `statusSelectorTones` below is what stops it going stale: a
   tone the stylesheet gives a rail status is compared whether or not anyone remembered to
   add it here. `warn` and `ok` are named by hand because neither is a rail status. Caution
   shares the panel with running and needs-you and is the warm tone nearest both, and done is
   the other word a turn head can carry. */
export const STATUS_TONES = ['ok', 'bad', 'warn', 'busy', 'need'] as const;

/* Every tone the stylesheet paints a rail status word with. `STATUS_TONES` has to hold all
   of them, which is the check that catches a state added to the rail and left out of the
   comparison. A tone drawn only somewhere else is not found here and is nobody's omission.

   One thing this cannot see: a rule that reaches the status word through a second custom
   property, as `.railstatus.paused { --busy: var(--paused); color: var(--busy); }` does. The
   scan reports `busy` there and the pixel is `paused`. A selector scan cannot follow an
   alias, and the rule against writing one is in `docs/timeline.md` beside this guard. */
export function statusSelectorTones(styleSource: string): string[] {
  const usages = toneUsages(styleSource);
  return Object.keys(usages)
    .filter((tone) => usages[tone].some(paintsARailStatus))
    .sort();
}

/* Whether a selector colours the rail status itself, rather than something standing next to
   one. Only the last compound of each comma-separated part is the element being drawn, so
   `.railstatus + .railwhen` paints the timestamp and does not count, while `.railstatus`
   alone, `.railstatus.running` and `.railstatus[data-state='paused']` all do. A rule on
   `.railstatus::before` counts: the mark it draws is part of the status word.

   `:not()` and `:has()` are taken out first, because neither names the element being drawn:
   one rules it out, the other tests what stands near it. `:is()` and `:where()` do name it,
   so each of their arguments is read as a selector in its own right.

   Three things are not recognised, and nothing in this stylesheet is written any of the three
   ways. A class name written as an escape rather than as letters. A double negative,
   `:not(:not(.railstatus))`, which this reads as the single negative it looks like. And a
   structural character quoted inside an attribute value, which ends the attribute here and
   does not end it in a browser. Each would mean parsing CSS rather than reading a selector. */
function paintsARailStatus(selector: string): boolean {
  const clean = selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[[^\]]*\]/g, '[]');
  return splitOutside(withoutSubjectless(clean), ',').some(drawsAStatus);
}

/* Whether one selector, already free of the pseudo-classes that do not name their subject,
   draws a rail status. The subject is the compound after the last combinator. Inside `:is()`
   or `:where()` each argument is a selector of its own, so each one's subject is read the
   same way: `:is(.railstatus, .other)` draws a status and `:is(.railstatus .child, .other)`
   draws a child of one. */
function drawsAStatus(selector: string): boolean {
  const compounds = splitOutside(selector.trim(), ' >+~');
  const last = compounds[compounds.length - 1] ?? '';
  if (/(^|[^\w-])\.railstatus($|[^\w-])/.test(last.replace(/\([^()]*\)/g, ''))) {
    return true;
  }
  return [...last.matchAll(/:(?:is|where)\(/g)].some((found) => {
    const inside = bracketAt(last, found.index + found[0].length - 1);
    return inside !== null && splitOutside(inside, ',').some(drawsAStatus);
  });
}

/* A selector with every `:not()` and its whole argument taken out, brackets counted so the
   one that closes it is its own. A regular expression cannot do this: written to stop at the
   first `)` it cuts `:not(:is(.other), .railstatus)` in half and leaves the name standing,
   and written to allow nested brackets it needs to count, which is this. */
function withoutSubjectless(selector: string): string {
  let text = selector;
  for (;;) {
    const found = /:(?:not|has)\(/.exec(text);
    if (!found) {
      return text;
    }
    const inside = bracketAt(text, found.index + found[0].length - 1);
    const after = inside === null ? text.length : found.index + found[0].length + inside.length + 1;
    text = text.slice(0, found.index) + text.slice(after);
  }
}

/* What one pair of brackets holds, given where the opening one is, or null when nothing
   closes it. Brackets are counted, so the closer found is the one belonging to this pair. */
function bracketAt(text: string, open: number): string | null {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '(') {
      depth += 1;
    }
    if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, at);
      }
    }
  }
  return null;
}

/* One selector cut at the given characters, counting only the ones outside brackets. A
   comma inside `:is()` joins that argument list and does not end a selector, and a space
   inside one is not a descendant combinator. */
function splitOutside(text: string, cuts: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let held = '';
  for (const character of text) {
    if (character === '(') {
      depth += 1;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && cuts.includes(character)) {
      if (held.trim()) {
        parts.push(held.trim());
      }
      held = '';
      continue;
    }
    held += character;
  }
  if (held.trim()) {
    parts.push(held.trim());
  }
  return parts;
}

/* CIE L*a*b*, from sRGB through D65. Colour distance needs a space where equal steps look
   about equal, which sRGB is not: two hex values far apart in channel numbers can be one
   colour to the eye, and two close ones can be plainly different. */
function toLab(colour: string, base: string): [number, number, number] {
  const raw = parseColor(colour);
  const solid = raw.a < 1 ? over(raw, parseColor(base)) : raw;
  const lin = (c: number) => {
    const t = c / 255;
    return t <= 0.04045 ? t / 12.92 : ((t + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(solid.r), lin(solid.g), lin(solid.b)];
  const xyz = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883,
  ].map((t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

/* How far apart two tones look, as CIEDE2000.

   The plain distance between two Lab points, CIE76, cannot do this job. It reports about 12
   for pairs a reader cannot separate at all: `#1f17ee` against `#0201ff` measures 12.05 that
   way and 1.77 this way. Three of the tones compared here are yellow to orange, which is a
   corner where the two formulas disagree, so the weaker one would sign off on the collision
   this exists to stop.

   CIEDE2000 corrects for lightness, chroma and hue against measured visual data. Its
   reference implementation and test vectors are Sharma, Wu and Dalal, and the vectors are
   what `tones.test.ts` pins this against. */
export function colourDistance(a: string, b: string, base = '#000000'): number {
  return labColourDistance(toLab(a, base), toLab(b, base));
}

/* The same figure between two Lab triples, so the published test vectors can be run against
   it without a colour to convert first. */
export function labColourDistance(
  [l1, a1, b1]: readonly [number, number, number],
  [l2, a2, b2]: readonly [number, number, number],
): number {
  const rad = Math.PI / 180;
  const cMean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  // c^7 / (c^7 + 25^7). Dividing through by 25^7 first keeps both terms in range for any
  // chroma an sRGB colour can produce, which tops out near 135. The function is exported for
  // the published vectors and so takes any finite triple: past about 1e44 the seventh power
  // is Infinity even scaled, and the ratio there is 1, which is the limit it is heading to.
  const seventh = (c: number) => {
    const scaled = (c / 25) ** 7;
    return Number.isFinite(scaled) ? scaled / (scaled + 1) : 1;
  };
  const g = 0.5 * (1 - Math.sqrt(seventh(cMean)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const angle = (y: number, x: number) => {
    if (y === 0 && x === 0) {
      return 0;
    }
    const deg = Math.atan2(y, x) / rad;
    return deg < 0 ? deg + 360 : deg;
  };
  const hp1 = angle(b1, ap1);
  const hp2 = angle(b2, ap2);
  const dL = l2 - l1;
  const dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) {
      dh -= 360;
    } else if (dh < -180) {
      dh += 360;
    }
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * rad);
  const lMean = (l1 + l2) / 2;
  const cpMean = (cp1 + cp2) / 2;
  let hMean: number;
  if (cp1 * cp2 === 0) {
    hMean = hp1 + hp2;
  } else if (Math.abs(hp1 - hp2) <= 180) {
    hMean = (hp1 + hp2) / 2;
  } else {
    hMean = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hMean - 30) * rad) +
    0.24 * Math.cos(2 * hMean * rad) +
    0.32 * Math.cos((3 * hMean + 6) * rad) -
    0.2 * Math.cos((4 * hMean - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(seventh(cpMean));
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cpMean;
  const sh = 1 + 0.015 * cpMean * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

/* Every pair of status tones, in every theme given, at the grounds where the two sit closest.

   Every ground is measured and not only the panel background. A tone can carry alpha, and a
   translucent word over a hovered row is a different pixel from the same word over the panel.

   The two are measured over every combination of grounds and not only over one shared
   ground, because the two words being compared are on different cards. One card is hovered
   while the next is not, and one is the selected row while the next is not, so the reader
   meets running on one ground and needs-you on another. Two tones that hold apart on every
   single ground can still converge across a pair of them.

   A ground the theme marks sole is left out of that cross product on both sides at once.
   Reporting a pair at its closest over two hovered cards names a view the rail never draws. */
/* The widest two pairs a reader can find that share no tone, reported as the narrower of the
   two. High when the palette holds two separate sessions of colour, and low when it has
   become one cluster with an outlier.

   This is the set-level question, and it is not a share of anything recorded, so a baseline
   someone regenerated cannot move it. A total of the ten distances cannot do this job: its
   largest terms carry it, so one tone moving a long way and every tone moving a little come
   out the same. Asking instead for two disjoint pairs that are both far apart is a fact about
   the shape of the set. Four tones huddled with a fifth away from them can offer only one
   wide pair, and whichever second pair is chosen alongside it comes from inside the huddle. */
export function widestDisjointPair(rows: readonly ToneDistance[]): number {
  const apart = new Map(rows.map((row) => [row.pair, row.distance]));
  let best = 0;
  for (const [first, one] of apart) {
    for (const [second, two] of apart) {
      const tones = [...first.split('/'), ...second.split('/')];
      if (new Set(tones).size !== 4) {
        continue;
      }
      best = Math.max(best, Math.min(one, two));
    }
  }
  return best;
}

export function statusToneDistances(styleSource: string, themes: readonly ThemeInput[]): ToneDistance[] {
  const rows: ToneDistance[] = [];
  for (const theme of themes) {
    const grounds = theme.grounds ?? BACKGROUNDS[theme.kind];
    if (!grounds.length) {
      throw new Error(`theme ${theme.id} gives no ground to measure a tone on`);
    }
    const sole = new Set(theme.soleGrounds ?? (theme.grounds ? [] : SOLE_GROUNDS));
    for (const at of sole) {
      // A position outside the list names no ground, so it takes no combination out and the
      // caller believes a rule is in force that is not. Louder than a quiet no-op.
      if (!Number.isInteger(at) || at < 0 || at >= grounds.length) {
        throw new Error(`theme ${theme.id} calls ground ${at} sole, and it gives ` + `${grounds.length} grounds`);
      }
    }
    const base = theme.base ?? grounds[0];
    const values = STATUS_TONES.map((tone) => toneValue(styleSource, theme.table, tone, theme.kind));
    const solidGrounds = grounds.map((candidate, at) => {
      const raw = parseColor(candidate);
      const solid = raw.a < 1 ? over(raw, parseColor(base)) : raw;
      return { name: candidate, at, css: `rgb(${solid.r}, ${solid.g}, ${solid.b})` };
    });
    for (let i = 0; i < STATUS_TONES.length; i++) {
      for (let j = i + 1; j < STATUS_TONES.length; j++) {
        let distance = Infinity;
        let at: [string, string] = [solidGrounds[0].name, solidGrounds[0].name];
        for (const first of solidGrounds) {
          for (const second of solidGrounds) {
            // A ground only one row wears cannot be under both words. Skipping it keeps the
            // sweep to combinations a reader can meet, so a pair is never reported closest
            // at two hovered cards, which the rail draws one of. Matched by position, so a
            // theme whose panel happens to be spelled like another theme's hovered row is
            // not read as one.
            if (first.at === second.at && sole.has(first.at)) {
              continue;
            }
            const here = labColourDistance(toLab(values[i], first.css), toLab(values[j], second.css));
            if (here < distance) {
              distance = here;
              at = [first.name, second.name];
            }
          }
        }
        if (!Number.isFinite(distance)) {
          throw new Error(
            `theme ${theme.id} marks every ground it gives as one only a single ` +
              'row wears, so no two cards can be compared in it',
          );
        }
        rows.push({
          pair: `${STATUS_TONES[i]}/${STATUS_TONES[j]}`,
          theme: theme.id,
          kind: theme.kind,
          values: [values[i], values[j]],
          grounds: at,
          distance,
        });
      }
    }
  }
  return rows;
}

/* Every tone the stylesheet writes as a word, measured in each theme given. A theme hands
   the webview a variable table, so the reading is taken through that table the way the
   editor sends it. */
export function measureTones(
  styleSource: string,
  themes: readonly ThemeInput[],
  options: { skip?: readonly string[] } = {},
): ToneReading[] {
  const skip = new Set(options.skip ?? []);
  const readings: ToneReading[] = [];
  for (const tone of textToneNames(styleSource)) {
    if (skip.has(tone)) {
      continue;
    }
    for (const theme of themes) {
      const value = toneValue(styleSource, theme.table, tone, theme.kind);
      const grounds = theme.grounds ?? BACKGROUNDS[theme.kind];
      // A hovered or selected row is often a percentage laid over the panel background, so
      // the first ground given is what the rest are composited over. A caller whose list does
      // not lead with an opaque panel colour names the base itself.
      const base = theme.base ?? grounds[0];
      const chipMix = CHIP_MIX[tone] ?? null;
      const worst = chipMix === null ? worstOf(value, grounds, base) : chipWorstOf(value, grounds, chipMix, base);
      readings.push({ tone, theme: theme.id, kind: theme.kind, value, chipMix, worst });
    }
  }
  return readings;
}
