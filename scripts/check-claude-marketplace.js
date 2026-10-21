const fs = require('node:fs');

try {
  const marketplaces = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (['--plugin-state', '--plugin-report'].includes(process.argv[2])) {
    if (!Array.isArray(marketplaces)) throw new Error('Claude plugin list is not an array');
    const plugin = marketplaces.find((entry) => entry?.id === 'arc-hooks@arc' && entry.scope === 'user');
    if (!plugin || typeof plugin.enabled !== 'boolean')
      throw new Error('Claude user plugin state is missing or invalid');
    if (process.argv[2] === '--plugin-state') console.log(plugin.enabled ? 'enabled' : 'disabled');
    else {
      if (!plugin.enabled) throw new Error('Claude user plugin is still disabled');
      if (plugin.errors?.length) throw new Error(`Claude failed to load arc-hooks@arc: ${plugin.errors.join(', ')}`);
      console.log(`==> Installed plugin version: ${plugin.version ?? 'unavailable from Claude metadata'}`);
      const source = plugin.source;
      console.log(`==> Plugin archive: ${source?.url ?? 'unavailable from Claude metadata'}`);
      console.log(`==> Plugin archive digest: ${source?.sha256 ?? 'unavailable from Claude metadata'}`);
      console.log('The extension revision does not pin the hosted plugin or the complete installation.');
    }
    return;
  }
  if (!Array.isArray(marketplaces)) throw new Error('Claude marketplace list is not an array');
  const current = marketplaces.filter((entry) => entry.name === 'arc');
  const conflicts = current.filter((entry) => {
    const type = typeof entry.source === 'object' ? entry.source?.source : entry.source;
    const url = typeof entry.source === 'object' ? entry.source?.url : entry.url;
    return type !== 'url' || url !== process.argv[2];
  });
  if (conflicts.length) {
    const sources = conflicts.map((entry) => {
      const source = typeof entry.source === 'object' ? entry.source : entry;
      const type = source?.source ?? 'unknown';
      const location = source?.url ?? source?.path ?? source?.repo ?? 'location unavailable';
      return `${type} (${location})`;
    });
    throw new Error(
      `The arc marketplace belongs to another source: ${sources.join(', ')}. ` +
        `Expected HTTPS catalog: ${process.argv[2]}. ` +
        'Resolve that marketplace manually before rerunning install.sh. ' +
        'Use --no-hooks to install the extension and preserve the existing Claude setup.',
    );
  }
  console.log(current.length ? 'existing' : 'missing');
} catch (error) {
  console.error(`warning: ${error.message}`);
  process.exitCode = 1;
}
