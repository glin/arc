const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HOLDERS, MANIFEST, releaseNotes, releaseVersion, versions } = require('./release-version.js');

const root = path.join(__dirname, '..');
const CHANGELOG = '# Changelog\n\n## Unreleased\n\n- Added a thing.\n\n## 0.1.0\n\nInitial release.\n';

function copy(changelog = CHANGELOG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-release-'));
  for (const { file } of HOLDERS) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

function snapshot(dir) {
  return Object.fromEntries(
    [...HOLDERS.map(({ file }) => file), 'CHANGELOG.md'].map((file) => [
      file,
      fs.readFileSync(path.join(dir, file), 'utf8'),
    ]),
  );
}

function bump(current) {
  const [major, minor] = current.split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}

test('every version holder carries the extension manifest version', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).version;
  for (const { file, field, value } of versions(root)) assert.equal(value, expected, `${file} ${field}`);
});

test('the private root package carries no version of its own', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, undefined);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, undefined);
  assert.equal(lock.packages[''].version, undefined);
});

test('the repository changelog can prepare its pending release', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const dir = copy(changelog);
  const current = versions(dir)[0].value;
  const version = changelog.includes(`## ${current} (Unreleased)`) ? current : bump(current);
  releaseVersion(dir, version, new Date('2026-10-02T23:30:00Z'));
  assert.ok(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').includes(`## ${version} (2026-10-02)`));
});

test.each(['\n', '\r\n'])('the first release dates its version without a bump or duplicate section (%j)', (eol) => {
  const dir = copy();
  const version = versions(dir)[0].value;
  fs.writeFileSync(
    path.join(dir, 'CHANGELOG.md'),
    `# Changelog${eol}${eol}## ${version} (Unreleased)${eol}${eol}Initial release.${eol}`,
  );
  releaseVersion(dir, version, new Date('2026-10-02T23:30:00Z'));
  const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.equal(
    changelog,
    `# Changelog${eol}${eol}## Unreleased${eol}${eol}## ${version} (2026-10-02)${eol}${eol}Initial release.${eol}`,
  );
  assert.equal(releaseNotes(changelog, version), 'Initial release.');
  for (const { value } of versions(dir)) assert.equal(value, version);
});

test('a release rewrites every holder and dates the Unreleased section', () => {
  const dir = copy();
  const before = snapshot(dir);
  const version = bump(versions(dir)[0].value);
  releaseVersion(dir, version, new Date('2026-10-02T23:30:00Z'));
  for (const { file, field, value } of versions(dir)) assert.equal(value, version, `${file} ${field}`);
  for (const { file } of HOLDERS) {
    const old = before[file].split('\n');
    const changed = fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter((line, index) => line !== old[index]);
    assert.ok(changed.length > 0 && changed.every((line) => line.includes(`"version": "${version}"`)), file);
  }
  const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.equal(
    changelog,
    `# Changelog\n\n## Unreleased\n\n## ${version} (2026-10-02)\n\n- Added a thing.\n\n## 0.1.0\n\nInitial release.\n`,
  );
  assert.equal(releaseNotes(changelog, version), '- Added a thing.');
  assert.equal(releaseNotes(changelog, '0.1.0'), 'Initial release.');
});

test('a release fails and writes nothing when the version is not greater', () => {
  const dir = copy();
  const before = snapshot(dir);
  const current = versions(dir)[0].value;
  assert.throws(() => releaseVersion(dir, current), /not greater/);
  assert.throws(() => releaseVersion(dir, '0.0.9'), /not greater/);
  assert.throws(() => releaseVersion(dir, 'v1.0.0'), /X\.Y\.Z/);
  assert.deepEqual(snapshot(dir), before);
});

test('a release fails and writes nothing without an Unreleased section', () => {
  const dir = copy('# Changelog\n\n## 0.1.0\n\nInitial release.\n');
  const before = snapshot(dir);
  assert.throws(() => releaseVersion(dir, bump(versions(dir)[0].value)), /no unreleased section/);
  assert.deepEqual(snapshot(dir), before);
});

test('a release keeps the changelog line endings', () => {
  const dir = copy(CHANGELOG.replaceAll('\n', '\r\n'));
  const version = bump(versions(dir)[0].value);
  releaseVersion(dir, version, new Date('2026-10-02T23:30:00Z'));
  assert.equal(
    fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
    `# Changelog\n\n## Unreleased\n\n## ${version} (2026-10-02)\n\n- Added a thing.\n\n## 0.1.0\n\nInitial release.\n`.replaceAll(
      '\n',
      '\r\n',
    ),
  );
});

test('a release that fails to write a later file restores the files it wrote', () => {
  const dir = copy();
  const before = snapshot(dir);
  const failing = path.join(dir, HOLDERS.at(-1).file);
  const write = (file, text) => {
    if (file === failing) throw new Error('disk full');
    fs.writeFileSync(file, text);
  };
  assert.throws(() => releaseVersion(dir, bump(versions(dir)[0].value), new Date(), write), /disk full/);
  assert.deepEqual(snapshot(dir), before);
});

test('release notes name a missing version', () => {
  assert.throws(() => releaseNotes(CHANGELOG, '9.9.9'), /no section for 9\.9\.9/);
});
