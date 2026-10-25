// Measures panel text contrast and status-color distance.
// The module reads the stylesheet and theme table instead of retaining copies.
// `panel.webview.test.ts` checks the 4.5:1 text contrast threshold with recorded exceptions.
// The panel-mockup skill uses these measurements in its tone sheet.
// Use these calculations for reported figures. Manual per-channel rounding differs from CSS color mixing.

/* Card and control backgrounds include the panel, sidebar-toned control bar, hovered row, and selected row without focus. */
export const BACKGROUNDS = {
  dark: ['#1f1f1f', '#181818', '#2a2d2e', '#37373d'],
  light: ['#ffffff', '#f8f8f8', '#f2f2f2', '#e4e6f1'],
} as const;

export type ThemeKind = keyof typeof BACKGROUNDS;

/* Indexes backgrounds exclusive to one row, including hover and selected-unfocused states. Two cards cannot both use these backgrounds.
   Exclusivity follows role indexes because equal color values can represent different roles in different themes. */
export const SOLE_GROUNDS: readonly number[] = [2, 3];

/* Tint percentages for tones whose chip backgrounds reduce contrast. `warn`, `full`, and `notice` share the context chip.
   `mod` colors a new draft. `ok` colors answered request values and tab marks on `--chipbg`.
   `--chipbg` mixes the editor foreground rather than the tone. Its approximation still gives lower contrast than the plain panel. */
export const CHIP_MIX: Readonly<Partial<Record<string, number>>> = {
  warn: 18,
  full: 26,
  notice: 12,
  mod: 18,
  ok: 9,
};

/* Non-status tones that do not require the 4.5 text contrast ratio.
   `--idle` uses the editor's de-emphasized text color. The guard and tone sheet exclude the same tones. */
export const EXCLUDED_TONES: Readonly<Record<string, string>> = {
  // .sbsep draws a literal separator between two status-bar figures. It is a mark between
  // two words, not a word of its own, the way a border or a bullet is not text either.
  edge: 'draws the status bar separator mark, not a word',
  // panel.css uses var(--vscode-descriptionForeground) for --idle.
  // This editor color keeps de-emphasized panel text consistent with the surrounding editor.
  idle: "the editor's own colour for text nobody is meant to read first",
};

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/* Parses hex and rgb values, including alpha. Translucent editor chart tokens require alpha-aware text contrast calculations. */
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

/* Returns the WCAG contrast ratio after compositing text over its background.
   A translucent background is first composited over `base`, then text alpha is applied.
   `base` represents the panel background. The transparent webview body ultimately uses the editor background. */
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

/* Contrast for text inside a background tinted with that text's tone.
   Mixing the tone into the background reduces contrast compared with the underlying background. */
export function chipWorstOf(fg: string, grounds: readonly string[], mixPercent: number, base = '#000000'): number {
  const f = parseColor(fg);
  const p = mixPercent / 100;
  return Math.min(
    ...grounds.map((bg) => {
      const raw = parseColor(bg);
      const b = raw.a < 1 ? over(raw, parseColor(base)) : raw;
      // color-mix includes the tone's alpha. A tone at one-third opacity mixed at 26% tints the background by about 9%.
      // Treating the tone as opaque overstates the browser's tint.
      const tint = p * f.a;
      const ground =
        `rgb(${tint * f.r + (1 - tint) * b.r}, ${tint * f.g + (1 - tint) * b.g}, ` +
        `${tint * f.b + (1 - tint) * b.b})`;
      return contrastOn(fg, ground);
    }),
  );
}

/* Collects top-level declarations with an exact normalized selector list.
   Exact matching distinguishes selectors with shared prefixes. Whitespace differences do not affect matching.
   Nested `@media` and `@supports` rules are excluded because their declarations apply conditionally. */
export function ruleBody(styleSource: string, selector: string): string {
  const source = withoutComments(styleSource);
  const wanted = selectorList(selector);
  const bodies: string[] = [];
  // Collect every matching rule in source order.
  // A selector can appear twice. Later declarations of equal importance take precedence.
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

/* Blanks CSS comments to spaces while preserving newlines and offsets.
   Commented declarations do not render. Braces in comments must not close a rule. */
function withoutComments(styleSource: string): string {
  return styleSource.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

/* Resolves editor tokens from the theme table before using their declared fallback.
   This preserves token alpha that an opaque fallback would omit. */
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

/* Collects custom properties used directly for text color.
   Reading declarations keeps newly added tones in the measurement set. */
export function textToneNames(styleSource: string): string[] {
  const names = new Set<string>();
  const re = /(?<![\w-])color:\s*var\(--(?!vscode-)([\w-]+)\)/g;
  let found: RegExpExecArray | null;
  while ((found = re.exec(styleSource))) {
    names.add(found[1]);
  }
  return [...names].sort();
}

/* Groups text-color selectors by tone name.
   Reading the stylesheet keeps the tone sheet aligned with declared uses. */
export function toneUsages(styleSource: string): Record<string, string[]> {
  const usages: Record<string, string[]> = {};
  // Exclude CSS comments so disabled declarations contribute no tone usage.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let rule: RegExpExecArray | null;
  while ((rule = re.exec(withoutComments(styleSource)))) {
    const selector = rule[1].replace(/\s+/g, ' ').trim();
    if (!selector) {
      continue;
    }
    // CSS variables in this stylesheet include fallbacks. End the variable name at a comma or closing bracket.
    // This keeps `var(--paused, #654321)` recognizable as --paused.
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

/* A theme's variables, editor kind, and four card backgrounds.
   Installed themes supply their own backgrounds. Omitted backgrounds use the editor kind's defaults. */
export interface ThemeInput {
  id: string;
  kind: ThemeKind;
  table: string;
  grounds?: readonly string[];
  /* Background positions that cannot appear on separate rows together.
   Omitting these positions and the backgrounds uses `SOLE_GROUNDS` for the kind's four defaults.
   Custom background lists require explicit positions. Omitting positions with a custom list treats every background as able to appear together. */
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

/* Status tones that require both readable text and distinguishable colors.
   `statusSelectorTones` checks session list status coverage. `warn` and `ok` also appear outside session list statuses. */
export const STATUS_TONES = ['ok', 'bad', 'warn', 'busy', 'need'] as const;

/* Collects tones directly used by session list status selectors. `STATUS_TONES` must include them.
   This scan does not follow custom-property aliases. For example, assigning `--busy: var(--paused)` still reports `busy`.
   Give each status selector its rendered tone directly so this scan compares the displayed colors. */
export function statusSelectorTones(styleSource: string): string[] {
  const usages = toneUsages(styleSource);
  return Object.keys(usages)
    .filter((tone) => usages[tone].some(paintsARailStatus))
    .sort();
}

/* Determine whether a selector colors the session list status. Inspect the last compound of each comma-separated selector.
   `.railstatus + .railwhen` colors the timestamp. `.railstatus`, `.railstatus.running`, and `.railstatus[data-state='paused']` color the status.
   `.railstatus::before` also counts because its mark forms part of the status.
   Remove `:not()` and `:has()`: they exclude the subject or test nearby elements. Inspect each argument of `:is()` and `:where()` as a selector.
   This reader does not support escaped class names, double negatives, or structural characters quoted in attributes.
   It treats `:not(:not(.railstatus))` as a single negative. Quoted structural characters end its attribute scan.
   The stylesheet avoids these forms, which require a CSS parser. */
function paintsARailStatus(selector: string): boolean {
  const clean = selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[[^\]]*\]/g, '[]');
  return splitOutside(withoutSubjectless(clean), ',').some(drawsAStatus);
}

/* Check a selector after removing pseudo-classes that do not name the subject. Its subject follows the last combinator.
   Inspect each `:is()` or `:where()` argument separately.
   `:is(.railstatus, .other)` draws a status. `:is(.railstatus .child, .other)` draws a child. */
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

/* Removes `:not()` and `:has()` arguments with balanced parentheses.
   Stopping at the first closing parenthesis would leave part of a nested argument in the selector. */
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

/* Convert sRGB through D65 to CIE L*a*b*.
   Equal steps in sRGB channels do not represent equal perceived color differences. L*a*b* provides the space for color distance. */
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

/* Returns CIEDE2000 color distance, correcting for lightness, chroma, and hue.
   CIE76 can overestimate separation near blue and yellow-orange.
   `tones.test.ts` uses the Sharma, Wu, and Dalal reference vectors. */
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
  // c^7 / (c^7 + 25^7). Divide by 25^7 to keep terms in range for sRGB chroma, which peaks near 135.
  // The exported function also accepts finite triples from published vectors.
  // Above about 1e44, even the scaled seventh power becomes Infinity. Return the limiting ratio of 1 there.
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

/* Summarizes pair distances for a status palette. */
/* Returns the largest minimum distance among two pairs with no shared tone.
   A palette with one distant outlier still needs a second separated pair to produce a large value.
   Summing all distances would let that outlier dominate the result. */
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
      // Reject indexes outside the background list because they cannot exclude any combination.
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
            // Measure every background combination except an exclusive role on both cards.
            // Two cards cannot both occupy the hovered or selected-unfocused row.
            // Match roles by index because equal color values can have different roles across themes.
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
      // Composite translucent hovered and selected backgrounds over the first background.
      // Callers whose list does not begin with an opaque panel color must supply the base.
      const base = theme.base ?? grounds[0];
      const chipMix = CHIP_MIX[tone] ?? null;
      const worst = chipMix === null ? worstOf(value, grounds, base) : chipWorstOf(value, grounds, chipMix, base);
      readings.push({ tone, theme: theme.id, kind: theme.kind, value, chipMix, worst });
    }
  }
  return readings;
}
