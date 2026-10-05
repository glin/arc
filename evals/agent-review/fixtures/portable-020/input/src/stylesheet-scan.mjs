import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { textSizesAreRelative } from './style-guard.mjs';
export async function checkPanelCss(root,name) {
  return textSizesAreRelative(await readFile(join(root,'src',name),'utf8'));
}
export function checkSnippet(css) { return textSizesAreRelative(css); }
