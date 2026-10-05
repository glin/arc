const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');

// The extension packaging toolchain already supplies yazl through its locked VSCE dependency.
const extensionRequire = createRequire(path.join(__dirname, '..', 'extension', 'package.json'));
const { ZipFile } = extensionRequire('yazl');

async function packageClaudePlugin(output, pluginRoot = path.join(__dirname, '..', 'plugins', 'arc-hooks')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== 'arc-hooks' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) {
    throw new Error('Arc plugin manifest has an invalid name or version');
  }
  fs.mkdirSync(output, { recursive: true });
  const asset = `arc-hooks-${manifest.version}.zip`;
  const zip = new ZipFile();
  function addDirectory(relative) {
    for (const entry of fs
      .readdirSync(path.join(pluginRoot, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) addDirectory(file);
      else if (entry.isFile() && !entry.name.endsWith('.test.js'))
        zip.addFile(path.join(pluginRoot, file), file, { mtime: new Date('2000-01-01T00:00:00Z'), mode: 0o100644 });
      else if (!entry.isFile()) throw new Error(`Unsupported plugin asset: ${file}`);
    }
  }
  for (const relative of ['.claude-plugin', 'hooks', 'scripts']) addDirectory(relative);
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(path.join(output, asset)));
  const sha256 = createHash('sha256')
    .update(fs.readFileSync(path.join(output, asset)))
    .digest('hex');
  fs.writeFileSync(path.join(output, `${asset}.sha256`), `${sha256}  ${asset}\n`);
  const catalog = {
    name: 'arc',
    description: 'Claude Code integrations for Arc.',
    owner: { name: 'glin' },
    plugins: [
      {
        name: 'arc-hooks',
        description: manifest.description,
        source: {
          source: 'archive',
          url: `https://github.com/glin/arc/releases/download/v${manifest.version}/${asset}`,
          sha256,
        },
      },
    ],
  };
  fs.writeFileSync(path.join(output, 'arc-marketplace.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return { asset, sha256, catalog };
}

if (require.main === module) {
  packageClaudePlugin(path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'release'))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { packageClaudePlugin };
