import fs from 'node:fs';
import path from 'node:path';
import { executeCodex, preflightCodex } from './live.mjs';
import { encoded, readJson } from './core.mjs';

const attempt = process.argv[2];
try {
  const input = readJson(path.join(attempt, 'input.json'));
  const execution =
    input.mode === 'preflight'
      ? { status: 'preflight-completed', cli: preflightCodex({ executablePath: input.executablePath }) }
      : await executeCodex(input);
  fs.writeFileSync(path.join(attempt, 'terminal.json'), encoded(execution), { flag: 'wx' });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
