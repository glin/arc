import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { absoluteTextSize } from './style-guard.mjs';
export async function stylesheetIsRelative(root, name) {
  const css=await readFile(join(root,'src',name),'utf8');
  return !absoluteTextSize(css);
}
