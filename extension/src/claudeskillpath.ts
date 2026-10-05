// Finds `SKILL.md` for a Claude skill name.
// The project `.claude/skills` folder takes priority over the config-home skills folder.
// `claudeConfigHome` honors `CLAUDE_CONFIG_DIR`. Neither lookup searches parent folders.
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
