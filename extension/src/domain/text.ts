// Browser-safe text shortening and name normalization.

// Shortens a line without splitting a UTF-16 surrogate pair.
// The result exceeds the limit when the ellipsis alone is longer than the limit.
export function shortenTo(line: string, limit: number, ellipsis: string): string {
  if (line.length <= limit) {
    return line;
  }
  // Clamp the slice boundary to zero. A negative boundary selects text from the end instead of returning an empty prefix.
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

// Preserve joiners, non-joiners, and emoji tag characters that form a glyph.
// Their preservation also permits visually identical names with different stored characters.
const HOLDS_A_GLYPH = /[\u200c\u200d\u{e0020}-\u{e007f}]/u;

// Remove trailing joiners after shortening. Preserve non-joiners and emoji tag characters.
const ORPHANED_JOINER = /\u200d+$/u;

// Visible names contain a character outside whitespace, controls, format marks, surrogates, and default-ignorable code points.
// Private-use and unassigned code points qualify.
const VISIBLE = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

// Normalize names before storing or displaying them. Non-string and invisible-only names return an empty string.
// Collapse whitespace before removing control characters so adjacent words remain separate.
// Normalize again after removal to compose newly adjacent characters.
// Trim after shortening and remove trailing joiners. The final visibility check applies to the shortened name.
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
