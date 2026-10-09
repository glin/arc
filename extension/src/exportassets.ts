import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportSiteAssets } from './exportsite';

export async function packagedExportAssets(extensionDirectory: string): Promise<ExportSiteAssets> {
  const [script, stylesheet] = await Promise.all([
    readFile(join(extensionDirectory, 'dist', 'export-viewer.js'), 'utf8'),
    readFile(join(extensionDirectory, 'dist', 'export-viewer.css'), 'utf8'),
  ]);
  return { script, stylesheet };
}
