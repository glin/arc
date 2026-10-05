// Claude's command catalog carries no flag for which entries are real skills. The Composer
// highlight instead reads the skill list published on the CLI's `init` message once a
// session's first prompt is underway, kept per working directory.

// Whether a Claude command earns the skill highlight. A known list highlights only the
// commands it names. No list ever seen for the working directory falls back to every
// command, which is the rule the Composer followed before a skill list existed. The caller
// excludes panel controls and the commands the Composer already draws its own control for.
export function claudeCommandIsSkill(command: string, skillNames: readonly string[] | null): boolean {
  if (skillNames === null) {
    return true;
  }
  const lower = command.toLowerCase();
  return skillNames.some((name) => name.toLowerCase() === lower);
}

// The skill lists last reported for each working directory. A session's own project skills
// depend on where it was started, so a worktree session reports a different list than a
// session opened at the repository root. A new list from a session replaces what an earlier
// session reported for that same directory, and leaves every other directory's list alone.
export function withDirectorySkills(
  lists: Readonly<Record<string, readonly string[]>>,
  directory: string,
  skills: readonly string[],
): Record<string, readonly string[]> {
  return { ...lists, [directory]: skills };
}

// Whether a directory's stored list already says what a newly reported list says, so a
// caller can skip writing state and pushing a payload that would change nothing on screen.
export function sameSkillList(stored: readonly string[] | undefined, skills: readonly string[]): boolean {
  return !!stored && stored.length === skills.length && stored.every((name, index) => name === skills[index]);
}

// Whether a skill name is safe to join onto a skills folder as its own single path segment.
// A name that carries a separator or climbs a directory could resolve outside the project or
// user skills folder, so the lookup rejects it before it ever reaches the filesystem. A
// plugin-qualified name such as `sample-plugin:sample-skill` fails this too, which keeps
// plugin skills out of the lookup: they are not filed under either skills folder. A name made
// only of dots climbs a directory the same way `..` does, and a trailing dot or space is one
// Windows strips when it resolves the folder, so either would name a different folder than the
// one this checks for.
export function safeSkillFolderName(name: string): boolean {
  if (!name || /^\.+$/.test(name) || /[. ]$/.test(name)) {
    return false;
  }
  return !/[\\/:]/.test(name);
}
