function shortenTo(line, limit, ellipsis) {
  if (line.length <= limit) {
    return line;
  }
  let cut = line.slice(0, Math.max(0, limit - ellipsis.length));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 55296 && last <= 56319) {
    cut = cut.slice(0, -1);
  }
  return cut + ellipsis;
}
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const HOLDS_A_GLYPH = /[\u200c\u200d\u{e0020}-\u{e007f}]/u;
const ORPHANED_JOINER = /\u200d+$/u;
const VISIBLE = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;
function cleanName(raw, limit) {
  if (typeof raw !== "string") {
    return "";
  }
  const spaced = raw.normalize("NFC").replace(/\p{White_Space}+/gu, " ");
  const stripped = spaced.replace(INVISIBLE, (ch) => HOLDS_A_GLYPH.test(ch) ? ch : "");
  const clean = stripped.normalize("NFC").trim();
  const cut = shortenTo(clean, limit, "").replace(ORPHANED_JOINER, "").trim();
  return VISIBLE.test(cut) ? cut : "";
}
export {
  cleanName,
  shortenTo
};
