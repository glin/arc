// Remove checkout-bound Arc hooks left by earlier source installations.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const legacyCommands = {
  PreToolUse: /\/hooks\/pretooluse-snapshot(?:\.cjs)?$/,
  Stop: /\/hooks\/stop-manifest(?:\.cjs)?$/,
  SessionStart: /\/hooks\/session-start(?:\.cjs)?$/,
};
const currentLegacyDir = path.join(__dirname, '..', 'hooks').replace(/\\/g, '/');

function legacyTarget(command) {
  let target = command.trim();
  if (target.startsWith('node ')) target = target.slice(5).trim();
  if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1);
  } else if (/\s/.test(target)) {
    return '';
  }
  target = target.replace(/\\/g, '/');
  return /^(?:[A-Za-z]:\/|\/)/.test(target) ? target : '';
}

function removeLegacyHooks(settingsFile) {
  if (!fs.existsSync(settingsFile)) return 0;
  if (fs.lstatSync(settingsFile).isSymbolicLink()) {
    console.warn(
      `Arc left hook settings unchanged because ${settingsFile} is a symlink. Update its managed target manually.`,
    );
    return 0;
  }
  const originalMode = fs.statSync(settingsFile).mode & 0o777;
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Hook settings must be a JSON object');
  }
  if (settings.hooks === undefined) return 0;
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    throw new Error('Hooks must be a JSON object');
  }
  let removed = 0;
  for (const event of Object.keys(legacyCommands)) {
    const groups = settings.hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups) || groups.some((group) => !group || !Array.isArray(group.hooks))) {
      throw new Error(`${event} hooks must be groups with hook lists`);
    }
  }
  for (const [event, matcher] of Object.entries(legacyCommands)) {
    const groups = settings.hooks[event];
    if (!groups) continue;
    settings.hooks[event] = groups
      .map((group) => {
        const hooks = group.hooks.filter((hook) => {
          const target =
            hook && hook.type === 'command' && typeof hook.command === 'string' && legacyTarget(hook.command);
          if (!target || !matcher.test(target)) return true;
          const owned = target === `${currentLegacyDir}/${path.posix.basename(target)}`;
          if (owned) removed++;
          else
            console.warn(
              `Arc left a possible old hook for manual cleanup because its source could not be confirmed: ${hook.command}`,
            );
          return !owned;
        });
        return { ...group, hooks };
      })
      .filter((group) => group.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (removed === 0) return 0;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  const temporary = path.join(path.dirname(settingsFile), `.${path.basename(settingsFile)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(temporary, originalMode);
    fs.renameSync(temporary, settingsFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return removed;
}

if (require.main === module) {
  const settingsFiles = [
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'),
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'),
  ];
  for (const settingsFile of settingsFiles) {
    try {
      const removed = removeLegacyHooks(settingsFile);
      if (removed) console.log(`Removed ${removed} old Arc hook entries from ${settingsFile}`);
    } catch (error) {
      console.error(`Could not migrate hooks in ${settingsFile}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { removeLegacyHooks };
