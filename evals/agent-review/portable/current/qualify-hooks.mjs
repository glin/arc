import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.argv[2];
const source = path.join(root, 'scripts/register-hooks.js');
const require = createRequire(source);
const { removeLegacyHooks } = require(source);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-hook-qualify-'));
try {
  const settings = path.join(temp, 'settings.json');
  const legacy = { type: 'command', command: `node "${path.join(root, 'hooks', 'pretooluse-snapshot.cjs')}"` };
  const unrelated = { type: 'command', command: 'node "/opt/company/hooks/pretooluse-snapshot.cjs"' };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [legacy] }] } }));
  const removed = removeLegacyHooks(settings);
  const normal = removed === 1 && JSON.parse(fs.readFileSync(settings, 'utf8')).hooks === undefined;

  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [legacy, unrelated] }] } }));
  removeLegacyHooks(settings);
  const second = JSON.parse(fs.readFileSync(settings, 'utf8'));
  process.stdout.write(
    JSON.stringify({
      checks: [
        { id: 'legacy-entry', role: 'normal', pass: normal },
        {
          id: 'unrelated-command',
          role: 'symptom',
          pass: second.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command === unrelated.command,
        },
      ],
    }),
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
