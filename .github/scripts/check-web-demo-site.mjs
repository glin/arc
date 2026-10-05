import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const site = resolve(process.argv[2] ?? '.scratch-web-demo/site');
const expected = ['adapter.js', 'demo.css', 'index.html', 'panel.css', 'panel.js', 'samples.js', 'themes.css'];
const entries = readdirSync(site, { withFileTypes: true });
const actual = entries.map((entry) => entry.name).sort();
if (actual.join('\n') !== expected.join('\n') || entries.some((entry) => !entry.isFile())) {
  throw new Error(`Unexpected static demo files: ${actual.join(', ')}`);
}

const privateContent = [
  /[A-Z]:(?:\\{1,2}|\/)(?:Users|Documents and Settings)(?:\\{1,2}|\/)/i,
  /\/(?:Users|home)\/[^\s/"'<>]+\//,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /github_pat_[A-Za-z0-9_]+/,
  /gh[pousr]_[A-Za-z0-9_]+/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
];

for (const name of expected) {
  const content = readFileSync(resolve(site, name));
  const text = content.toString('utf8');
  if (privateContent.some((pattern) => pattern.test(text))) {
    throw new Error(`${name} contains a private path or credential pattern`);
  }
  const panelTokens = text.match(/__ARC_[A-Z0-9_]+__/g) ?? [];
  if (panelTokens.some((token) => token !== '__ARC_DEMO_SAMPLES__')) {
    throw new Error(`${name} contains an unresolved panel token`);
  }
  console.log(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
}
