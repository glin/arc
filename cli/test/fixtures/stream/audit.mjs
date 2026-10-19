import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditStreams } from './audit-core.mjs';

const defaultDirectory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || separator === args.length - 1) {
  console.error('Usage: audit.mjs [--map FILE] [--fixtures DIRECTORY] -- COMMAND ... {}');
  process.exit(2);
}
let mapping = {};
const options = args.slice(0, separator);
const fixtureIndex = options.indexOf('--fixtures');
if (fixtureIndex >= 0 && fixtureIndex + 1 >= separator) {
  console.error('--fixtures needs a directory before --');
  process.exit(2);
}
const directory = fixtureIndex >= 0 ? options[fixtureIndex + 1] : defaultDirectory;
const mapIndex = options.indexOf('--map');
if (mapIndex >= 0) {
  if (mapIndex + 1 >= separator) {
    console.error('--map needs a JSON file before --');
    process.exit(2);
  }
  mapping = JSON.parse(readFileSync(options[mapIndex + 1], 'utf8'));
}
const command = args.slice(separator + 1);
const messages = auditStreams({
  directory,
  command,
  mapping,
  execute: (invocation) => spawnSync(invocation[0], invocation.slice(1), { encoding: 'utf8' }),
});
for (const message of messages) console.error(message);
process.exitCode = messages.length ? 1 : 0;
