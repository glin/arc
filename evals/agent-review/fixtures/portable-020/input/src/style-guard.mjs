export function textSizesAreRelative(css) {
  const declarations=[...css.matchAll(/(?:font-size|line-height)\s*:\s*([^;}]+)/gi)];
  return declarations.every(([,value]) => !/\d+(?:\.\d+)?\s*(?:px|pt|pc|in|cm|mm|q)\b/i.test(value));
}
