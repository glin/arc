// @module-tag subprocess
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inspector = path.resolve(__dirname, '../.github/scripts/check-web-demo-site.mjs');
const siteFiles = ['adapter.js', 'demo.css', 'index.html', 'panel.css', 'panel.js', 'samples.js', 'themes.css'];

test('static demo inspection rejects literal and JSON-escaped Windows home paths', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-web-demo-inspect-'));
  try {
    for (const name of siteFiles) fs.writeFileSync(path.join(site, name), 'safe sample content');
    const samples = path.join(site, 'samples.js');
    const homePath = String.raw`C:\Users\example-user\private\file.ts`;

    for (const content of [homePath, JSON.stringify(homePath)]) {
      fs.writeFileSync(samples, content);
      const result = spawnSync(process.execPath, [inspector, site], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, content);
      assert.match(result.stderr, /samples\.js contains a private path or credential pattern/);
    }
  } finally {
    fs.rmSync(site, { recursive: true, force: true });
  }
});
