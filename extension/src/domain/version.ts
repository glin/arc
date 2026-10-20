// Release version parsing and ordering for the CLI version floors Arc checks.

export interface Version {
  readonly release: readonly [number, number, number];
  // Dot-separated prerelease identifiers. An empty list marks a release.
  readonly prerelease: readonly string[];
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC = /^\d+$/;

// Parses `MAJOR.MINOR.PATCH` with an optional `-prerelease` suffix. Leading zeros parse as numbers.
export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

// Orders two versions by semantic-version precedence. A prerelease ranks below its own release.
export function compareVersion(left: Version, right: Version): number {
  for (let i = 0; i < 3; i++) if (left.release[i] !== right.release[i]) return left.release[i] - right.release[i];
  if (!left.prerelease.length || !right.prerelease.length) return right.prerelease.length - left.prerelease.length;
  for (let i = 0; i < Math.min(left.prerelease.length, right.prerelease.length); i++) {
    const order = compareIdentifier(left.prerelease[i], right.prerelease[i]);
    if (order) return order;
  }
  return left.prerelease.length - right.prerelease.length;
}

// Numeric identifiers compare as numbers and rank below alphanumeric identifiers.
function compareIdentifier(left: string, right: string): number {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
