// Git can print different abbreviation lengths for one object. Two recorded shas identify
// one commit when either is the hexadecimal prefix of the other.
export function sameCommitSha(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

// Git prints a sha in lower case, so a lower-case hex word of seven to forty characters names
// a commit, and anything else names a ref. A ref spelled in upper-case hex is therefore a name,
// not a commit, and every caller that tells a hash from a ref shares this one shape.
export const HEX_SHA = /^[0-9a-f]{7,40}$/;
