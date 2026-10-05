// Set a release version in every file that carries one and close the changelog's Unreleased section.
// `node scripts/release-version.js X.Y.Z` writes the release. `--notes X.Y.Z` prints that version's changelog section.
const fs = require('node:fs');
const path = require('node:path');

// `extension/package.json` owns the version. The other holders repeat it because npm, the
// CLI package and Claude Code each read their own manifest.
const MANIFEST = 'extension/package.json';
const HOLDERS = [
  { file: 'extension/package.json', fields: [['version']] },
  { file: 'extension/package-lock.json', fields: [['version'], ['packages', '', 'version']] },
  { file: 'cli/package.json', fields: [['version']] },
  { file: 'cli/package-lock.json', fields: [['version'], ['packages', '', 'version']] },
  { file: 'plugins/arc-hooks/.claude-plugin/plugin.json', fields: [['version']] },
];
const CHANGELOG = 'CHANGELOG.md';
const UNRELEASED = /^## (?:Unreleased|(\d+\.\d+\.\d+) \(Unreleased\))[ \t]*$/m;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function read(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function field(value, keys) {
  return keys.reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), value);
}

function versions(root) {
  return HOLDERS.flatMap(({ file, fields }) => {
    const json = JSON.parse(read(root, file));
    return fields.map((keys) => ({ file, field: keys.join('.'), value: field(json, keys) }));
  });
}

function parse(version) {
  const match = SEMVER.exec(version ?? '');
  return match ? match.slice(1).map(Number) : undefined;
}

function greater(next, current) {
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
}

// Rewrites the first `fields.length` version strings in the file's own text, so its formatting
// stays as it is. The parsed result must differ from the original in those fields alone.
function rewrite(text, { file, fields }, version) {
  let left = fields.length;
  const next = text.replace(/"version"(\s*):(\s*)"[^"]*"/g, (match, before, after) => {
    if (left === 0) return match;
    left -= 1;
    return `"version"${before}:${after}"${version}"`;
  });
  const expected = JSON.parse(text);
  for (const keys of fields) {
    const parent = field(expected, keys.slice(0, -1));
    if (parent === undefined || field(expected, keys) === undefined)
      throw new Error(`${file} has no ${keys.join('.')} field.`);
    parent[keys.at(-1)] = version;
  }
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(expected))
    throw new Error(`${file} holds its version fields in an unexpected order. Edit it by hand.`);
  return next;
}

function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## ${version.replaceAll('.', '\\.')}(?: \\(.*\\))?[ \\t]*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`${CHANGELOG} has no section for ${version}.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

// Validates everything before it writes anything. When a write fails, it writes back the files
// it already changed, so a failed release leaves every file as it was.
function releaseVersion(root, version, now = new Date(), write = fs.writeFileSync) {
  const next = parse(version);
  if (!next) throw new Error(`${version} is not a version of the form X.Y.Z.`);
  const current = JSON.parse(read(root, MANIFEST)).version;
  const changelog = read(root, CHANGELOG);
  const unreleased = UNRELEASED.exec(changelog);
  const pendingCurrent = version === current && unreleased?.[1] === current;
  if (!pendingCurrent && !greater(next, parse(current) ?? [0, 0, 0]))
    throw new Error(`${version} is not greater than the current version ${current}.`);
  if (!unreleased) throw new Error(`${CHANGELOG} has no unreleased section.`);
  const date = now.toISOString().slice(0, 10);
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
  const writes = HOLDERS.map((holder) => {
    const before = read(root, holder.file);
    return { file: holder.file, before, after: rewrite(before, holder, version) };
  });
  writes.push({
    file: CHANGELOG,
    before: changelog,
    after: changelog.replace(UNRELEASED, `## Unreleased${eol}${eol}## ${version} (${date})`),
  });
  const written = [];
  try {
    for (const entry of writes) {
      write(path.join(root, entry.file), entry.after);
      written.push(entry);
    }
  } catch (error) {
    for (const { file, before } of written) write(path.join(root, file), before);
    throw error;
  }
  return writes.map(({ file }) => file);
}

function main(args) {
  const root = path.join(__dirname, '..');
  if (args[0] === '--notes') {
    process.stdout.write(`${releaseNotes(read(root, CHANGELOG), args[1] ?? '')}\n`);
    return;
  }
  if (args.length !== 1) throw new Error('Usage: npm run release -- X.Y.Z');
  const version = args[0];
  const files = releaseVersion(root, version);
  console.log(`Set version ${version}. Review the changes, then run:`);
  console.log(`  git commit -m "chore(release): ${version}" -- ${files.join(' ')}`);
  console.log(`  git tag v${version}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { HOLDERS, MANIFEST, releaseNotes, releaseVersion, versions };
