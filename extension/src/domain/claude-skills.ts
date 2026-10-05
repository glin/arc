// A known skill list highlights only matching command names.
// A missing list highlights every command.
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

// Rejects separators, colon-qualified names, all-dot names, and trailing dots or spaces.
// Accepted names fit one project or user skills folder segment.
export function safeSkillFolderName(name: string): boolean {
  if (!name || /^\.+$/.test(name) || /[. ]$/.test(name)) {
    return false;
  }
  return !/[\\/:]/.test(name);
}
