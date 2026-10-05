function sameCommitSha(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}
const HEX_SHA = /^[0-9a-f]{7,40}$/;
export {
  HEX_SHA,
  sameCommitSha
};
