// Browser-safe text rules shared by every side that has to fit a line into a title, and by
// every box a reader types a name into.

// Shorten a line to fit a title, without leaving half a character behind. `slice` counts
// UTF-16 code units, and an emoji is two of them, so a cut at a fixed count of them can land
// between the halves of one. The half left behind draws as an empty box, and a summary
// headline carries an emoji whenever the line it came from opens with one. The result fits
// `limit`, unless the ellipsis alone does not fit it.
export function shortenTo(line: string, limit: number, ellipsis: string): string {
  if (line.length <= limit) {
    return line;
  }
  // Held at or above zero. A negative second argument to `slice` counts from the end of the
  // line instead of cutting it, so a limit shorter than the ellipsis would return more than
  // it was given rather than less.
  let cut = line.slice(0, Math.max(0, limit - ellipsis.length));
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate at the end lost its pair to the cut, so it is half a character.
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut + ellipsis;
}

// The characters that draw nothing, and are safe to take out of a name.
//
// The controls, the format characters and the lone surrogates. Not the private-use areas,
// which a font theme fills with glyphs a reader can see, and not the unassigned range, which
// draws a box rather than nothing at all.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

// The format characters that hold a glyph together rather than standing in a name on their
// own, kept wherever they are.
//
// The joiner is what makes one family emoji out of several people, and it does the same work
// after a virama in Devanagari and the scripts beside it. The non-joiner blocks that join and
// is a letter-level character in the same scripts. A run of tag characters is what turns a
// black flag into a subdivision flag.
//
// Kept wherever they are, and the cost of that is real: a joiner between two letters joins
// nothing and draws nothing, so a name pasted out of rendered web text can reach storage as a
// second name that draws exactly like one the reader already has. Deciding whether a joiner
// joins anything needs the grapheme rules rather than a character class, and every cheaper
// test breaks more than it fixes: one that asks for an emoji in front of the joiner throws
// away the joiner in every skin-toned emoji and every Indic conjunct. So the lookalike stays,
// and the box that types a name is where the reader is told about a collision.
const HOLDS_A_GLYPH = /[\u200c\u200d\u{e0020}-\u{e007f}]/u;

// A joiner the cut left at the end of a name, where it joins nothing by construction.
//
// The cut counts UTF-16 units and knows nothing about where a sequence ends, so a name whose
// ceiling falls inside a family emoji comes back ending in a joiner. That draws exactly like
// the same name without it and folds to a different key, which is one name the reader can
// see twice. `shortenTo` drops a high surrogate the same cut orphaned, for the same reason.
//
// The joiner alone, and not the tag characters beside it above: a subdivision flag ends in a
// tag, so a rule that swept those would turn every flag into a black one. The non-joiner is
// left as well, because a word in the scripts that use it can end with one.
const ORPHANED_JOINER = /\u200d+$/u;

// One character a reader can actually see. Whitespace is not one, nor is anything the strip
// above takes out, nor anything Unicode marks as ignorable by default, which is how a name
// made of a variation selector or a run of tag characters alone is caught.
//
// A private-use code point is one, because the reader's own font theme draws it, and so is an
// unassigned one, which draws a box. A box is a poor name and it is still something on the
// screen, which is more than this can say about the reader's intent.
const VISIBLE = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

// One name as it will be stored and drawn: the reader's own words, run together and cut to
// fit the control that carries them.
//
// Two boxes type a name into this panel, a label's and a view's, and both reach here. Anything
// that is not a string answers with the empty string rather than throwing. This is the one
// gate every name goes through, typed ones and stored ones alike, and the stored ones come
// back from storage that outlives the code that wrote them. The empty answer is what every
// caller drops on, so one bad name costs its own entry and nothing else.
//
// The trim runs twice on purpose. The cut counts characters and knows nothing about where a
// word ends, so a name cut at the ceiling can end on the space between two words, and a chip
// carrying a trailing space draws a gap the reader cannot account for.
//
// The steps below run in the order they are written, and the order is what makes them right.
//
// The name goes into NFC first. The same visible word reaches storage two ways, with an
// accent as one character or as a letter and a combining mark, and the two are different
// strings to every comparison here. A reader would then carry two names that draw
// identically and cannot be told apart anywhere.
//
// Then every run of whitespace becomes one space. This runs before the strip below, not
// after it: a tab and a line break are control characters as well as spaces, so a strip that
// went first would delete them and join the words either side into one. That is what a paste
// out of a browser table gives, and `release 0.4` would arrive as `release0.4`.
//
// `\p{White_Space}` rather than `\s`, which is nearly the same set. It holds the next-line
// character, which is a line break the strip would otherwise delete. It leaves out the byte
// order mark, which is not a space at all and which the strip below is the right answer for.
//
// Then the characters that draw nothing go: the controls, the zero-width spaces, the
// direction marks, the soft hyphen. The private-use glyphs a font theme supplies stay, and so
// do the combining marks that sit on a letter, and so do the joiners and the tag characters,
// which hold one glyph together out of several.
//
// Then NFC again, because taking a zero-width space out from between a letter and its
// accent leaves two characters that compose into one.
//
// Then the cut. It counts UTF-16 units, which is what `shortenTo` counts, so a skin tone or
// a variation selector can be taken off the end of a name that reaches the ceiling.
//
// Then, last of all, a name with nothing visible left in it is not a name. The rules above
// cannot answer that on their own: a name made of a variation selector alone survives every
// one of them, and the panel would draw an outlined chip with a border around nothing, under
// an accessible name closing with a word the reader cannot read, and no control would take
// it off because the entry is a name like any other.
//
// It runs after the cut rather than before it, because the cut can take the only visible
// character a name had. A name of variation selectors with one letter past the ceiling passes
// a check made first, and what reaches the screen is the selectors.
//
// The cut itself is `shortenTo` above. It drops a high surrogate left without its pair, which
// a plain slice keeps as half a character. The ellipsis is empty because a name is the
// reader's own word: a name ending in three dots is a different name from the one they typed,
// and it is the name the next lookup matches on.
export function cleanName(raw: unknown, limit: number): string {
  if (typeof raw !== 'string') {
    return '';
  }
  const spaced = raw.normalize('NFC').replace(/\p{White_Space}+/gu, ' ');
  const stripped = spaced.replace(INVISIBLE, (ch) => (HOLDS_A_GLYPH.test(ch) ? ch : ''));
  const clean = stripped.normalize('NFC').trim();
  const cut = shortenTo(clean, limit, '').replace(ORPHANED_JOINER, '').trim();
  return VISIBLE.test(cut) ? cut : '';
}
