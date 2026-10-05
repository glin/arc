// Where Arc finds the file behind a Claude skill mark. Claude's `init` message names a skill
// but never says where its `SKILL.md` lives, unlike Codex, which publishes a path on its own
// catalog. This checks `<cwd>/.claude/skills/<name>/SKILL.md` first, then `<name>/SKILL.md`
// under the config-home skills folder, by the skill's command name, so a custom
// `CLAUDE_CONFIG_DIR` is honoured the same way it is everywhere else in Arc. Neither check
// walks up through parent folders. Reads happen here, on the host, in a module that never
// imports `vscode`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeConfigHome } from './agentpaths';
import { safeSkillFolderName } from './domain/claude-skills.ts';

export function claudeSkillPath(name: string, projectDir: string | null): string | null {
  if (!safeSkillFolderName(name)) {
    return null;
  }
  const roots = [
    projectDir ? path.join(projectDir, '.claude', 'skills') : null,
    path.join(claudeConfigHome(), 'skills'),
  ].filter((root): root is string => root !== null);
  for (const root of roots) {
    const candidate = path.join(root, name, 'SKILL.md');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
