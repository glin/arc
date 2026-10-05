const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('each Vitest project selects only tests in its package', () => {
  const root = read('vitest.config.mts');
  const extension = read('extension/vitest.config.ts');
  const cli = read('cli/vitest.config.ts');
  assert.match(
    root,
    /include: \['plugins\/\*\*\/\*\.test\.js', 'scripts\/\*\*\/\*\.test\.js', 'test\/\*\*\/\*\.test\.js'\]/,
  );
  // The shared run setup lives under extension/test. Every other root option must stay inside the root package.
  assert.doesNotMatch(root.replace(/^ *globalSetup: .*$/m, ''), /extension|cli/);
  assert.match(extension, /include: \['src\/\*\*\/\*\.test\.ts'\]/);
  assert.match(cli, /include: \['test\/\*\*\/\*\.test\.\{ts,mjs\}'\]/);
});
