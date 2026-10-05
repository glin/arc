const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the documented F5 launch opens the repository with the nested built extension', () => {
  const file = path.join(__dirname, '..', '.vscode', 'launch.json');
  assert.equal(fs.existsSync(file), true, 'the repository has no F5 launch configuration');
  const launch = JSON.parse(fs.readFileSync(file, 'utf8'));
  const configuration = launch.configurations.find((entry) => entry.type === 'extensionHost');
  assert.ok(configuration, 'the launch configuration has no Extension Development Host');
  assert.equal(configuration.request, 'launch');
  assert.deepEqual(configuration.args, [
    '--extensionDevelopmentPath=${workspaceFolder}/extension',
    '${workspaceFolder}',
  ]);
  assert.deepEqual(configuration.outFiles, ['${workspaceFolder}/extension/dist/**/*.js']);
});

test('the isolated launcher separates settings and installed extensions', () => {
  const scriptPath = path.join(__dirname, 'launch-isolated-extension.ps1');
  assert.equal(fs.existsSync(scriptPath), true, 'the isolated VS Code launcher is missing');
  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.match(script, /npm --prefix \$extensionPath run build/);
  assert.match(script, /'--user-data-dir', \$userData/);
  assert.match(script, /'--extensions-dir', \$extensions/);
  assert.match(script, /'--extensionDevelopmentPath', \$extensionPath/);
  assert.match(script, /\[guid\]::NewGuid\(\)/);

  const development = fs.readFileSync(path.join(__dirname, '..', 'docs', 'development.md'), 'utf8');
  assert.match(development, /launch-isolated-extension\.ps1/);
});
