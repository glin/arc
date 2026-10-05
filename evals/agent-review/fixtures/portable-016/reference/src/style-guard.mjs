export function absoluteTextSize(css) {
  return /(?:font-size|line-height)\s*:\s*\d+(?:\.\d+)?(?:px|pt|q)\b/i.test(css);
}
