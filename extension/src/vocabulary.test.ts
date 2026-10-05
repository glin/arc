import { test } from 'vitest';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.md', '.ts']);

function shippedSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...shippedSources(fullPath));
      continue;
    }
    if (
      !SOURCE_EXTENSIONS.has(path.extname(entry.name)) ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.browser.test.ts') ||
      entry.name === 'turnfixtures.ts'
    ) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function maskBoundaryTerms(file: string, source: string): string {
  if (file.endsWith(`${path.sep}README.md`)) {
    return source.replace(
      'one resumable conversation with its lifetime cost',
      'one resumable session with its lifetime cost',
    );
  }
  if (file.endsWith(`${path.sep}transcript.ts`)) {
    return source.replace(
      'covers the earlier portion of the conversation',
      'covers the earlier portion of the vendor context',
    );
  }
  if (file.endsWith(`${path.sep}agent-protocols.md`)) {
    return source.replaceAll('conversation_reset', 'session_reset').replaceAll('new_conversation_id', 'new_session_id');
  }
  return source;
}

test('product vocabulary uses session outside retained boundaries', () => {
  const extensionRoot = path.join(__dirname, '..');
  const repositoryRoot = path.join(extensionRoot, '..');
  const documents = shippedSources(path.join(repositoryRoot, 'docs')).filter(
    (file) => path.extname(file) === '.md' && path.basename(file) !== 'spec.md',
  );
  const files = [
    path.join(extensionRoot, 'package.json'),
    ...shippedSources(__dirname),
    path.join(repositoryRoot, 'README.md'),
    ...documents,
  ];
  const failures: string[] = [];

  for (const file of files) {
    const source = maskBoundaryTerms(file, fs.readFileSync(file, 'utf8'));
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (/conversation/i.test(lines[index])) {
        failures.push(`${path.relative(extensionRoot, file)}:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }

  assert.deepEqual(failures, [], `retired product vocabulary remains:\n${failures.join('\n')}`);
});
