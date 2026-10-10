import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const site = resolve(process.argv[2] ?? '.scratch-web-demo/site');
const privateContent = [
  /[A-Z]:(?:\\{1,2}|\/)(?:Users|Documents and Settings)(?:\\{1,2}|\/)/i,
  /\/(?:Users|home)\/[^\s/"'<>]+\//,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /github_pat_[A-Za-z0-9_]+/,
  /gh[pousr]_[A-Za-z0-9_]+/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
];
const samplesText = readFileSync(resolve(site, 'samples.js'), 'utf8');
if (privateContent.some((pattern) => pattern.test(samplesText)))
  throw new Error('samples.js contains a private path or credential pattern');

const downloads = JSON.parse(readFileSync(resolve(site, 'exports.json'), 'utf8'));
if (!downloads || Array.isArray(downloads) || typeof downloads !== 'object' || !Object.keys(downloads).length)
  throw new Error('The demo export catalog is unavailable');
for (const [id, file] of Object.entries(downloads)) {
  if (!/^[a-z0-9-]+$/.test(id) || file !== `export-${id}.html`) throw new Error('Unexpected demo export identity');
}
const samples = JSON.parse(
  samplesText
    .replace(/^window\.__ARC_DEMO_SAMPLES__ = /, '')
    .trim()
    .replace(/;$/, ''),
);
if (
  JSON.stringify(samples.exports) !== JSON.stringify(downloads) ||
  Object.keys(samples.payloads).sort().join('\n') !== Object.keys(downloads).sort().join('\n')
)
  throw new Error('The demo export catalog does not match the samples');
const expected = [
  'adapter.js',
  'demo.css',
  'index.html',
  'panel.css',
  'panel.js',
  'samples.js',
  'themes.css',
  'exports.json',
  ...Object.values(downloads),
].sort();
const entries = readdirSync(site, { withFileTypes: true });
const actual = entries.map((entry) => entry.name).sort();
if (actual.join('\n') !== expected.join('\n') || entries.some((entry) => !entry.isFile())) {
  throw new Error(`Unexpected static demo files: ${actual.join(', ')}`);
}

for (const name of expected) {
  const content = readFileSync(resolve(site, name));
  const text = content.toString('utf8');
  const decoded = [
    ...text.matchAll(/<script type="application\/octet-stream" id="arc-data-[^"]+">([^<]+)<\/script>/g),
  ].map((match) => Buffer.from(match[1], 'base64').toString('utf8'));
  if (privateContent.some((pattern) => [text, ...decoded].some((value) => pattern.test(value)))) {
    throw new Error(`${name} contains a private path or credential pattern`);
  }
  if (name.startsWith('export-')) {
    const manifestBlock = text.match(/id="arc-data-manifest">([^<]+)<\/script>/);
    const manifest = manifestBlock && JSON.parse(Buffer.from(manifestBlock[1], 'base64').toString('utf8'));
    if (
      !manifest ||
      name !== downloads[manifest.root] ||
      !text.includes('<style>') ||
      /<link\b/.test(text.slice(0, text.indexOf('<script')))
    )
      throw new Error(`${name} is not a standalone selected-session export`);
    const reachable = new Set([manifest.root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of manifest.relationships)
        if (reachable.has(edge.from) && edge.to && !reachable.has(edge.to)) {
          reachable.add(edge.to);
          changed = true;
        }
    }
    if (
      manifest.sessions.some((session) => !reachable.has(session.key)) ||
      [...reachable].some((id) => !manifest.sessions.some((session) => session.key === id))
    )
      throw new Error(`${name} contains an invalid session graph`);
  }
  const panelTokens = text.match(/__ARC_[A-Z0-9_]+__/g) ?? [];
  if (panelTokens.some((token) => token !== '__ARC_DEMO_SAMPLES__')) {
    throw new Error(`${name} contains an unresolved panel token`);
  }
  console.log(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
}
