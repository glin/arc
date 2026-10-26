import { applyPatch } from 'diff';
import { patchMarkersAreValid, type EditRecord } from './transcript';

// Build both sides of a per-turn file diff from recorded text.
// Never read the after side from the live file. Later edits belong to other turns.

// Whether the diff contains whole files or only changed regions.
export type DiffSource = 'recorded' | 'hunks';

export interface FileSides {
  before: string;
  after: string;
  source: DiffSource;
}

// Format a changed region's line ranges as a unified diff header.
function hunkHeader(hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number }): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function patchFitsRecordedText(text: string, hunks: EditRecord['hunks']): boolean {
  if (!patchMarkersAreValid(hunks)) {
    return false;
  }
  const lines = text ? text.replace(/\r?\n$/, '').split('\n') : [];
  const finalLineCount = lines.length + hunks.reduce((delta, hunk) => delta + hunk.newLines - hunk.oldLines, 0);
  let previousOldEnd = 0;
  let lineDelta = 0;
  for (const hunk of hunks) {
    if ((hunk.oldLines > 0 && hunk.oldStart === 0) || (hunk.newLines > 0 && hunk.newStart === 0)) {
      return false;
    }
    const oldAt = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    const newAt = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    if (oldAt < previousOldEnd || oldAt + hunk.oldLines > lines.length || newAt !== oldAt + lineDelta) {
      return false;
    }
    let sourceAt = oldAt;
    let targetAt = newAt;
    let seenOld = 0;
    let seenNew = 0;
    for (let index = 0; index < hunk.lines.length; index++) {
      const line = hunk.lines[index];
      if (line.startsWith(' ') || line.startsWith('-')) {
        if (lines[sourceAt] !== line.slice(1)) {
          return false;
        }
        sourceAt++;
        seenOld++;
      }
      if (line.startsWith(' ') || line.startsWith('+')) {
        targetAt++;
        seenNew++;
      }
      if (line === '\\ No newline at end of file') {
        const prefix = hunk.lines[index - 1][0];
        if ((prefix === ' ' || prefix === '-') && sourceAt !== lines.length) {
          return false;
        }
        if ((prefix === ' ' || prefix === '+') && targetAt !== finalLineCount) {
          return false;
        }
      }
      if (
        !(
          line.startsWith(' ') ||
          line.startsWith('+') ||
          line.startsWith('-') ||
          line === '\\ No newline at end of file'
        )
      ) {
        return false;
      }
    }
    if (seenOld !== hunk.oldLines || seenNew !== hunk.newLines) {
      return false;
    }
    previousOldEnd = oldAt + hunk.oldLines;
    lineDelta += hunk.newLines - hunk.oldLines;
  }
  return true;
}

// Rebuild whole files from recorded edits. Return null when recorded text cannot establish both sides.
function wholeFiles(edits: EditRecord[]): FileSides | null {
  const first = edits[0];
  let text: string;
  if (typeof first.originalFile === 'string') {
    text = first.originalFile;
  } else if (first.isCreate) {
    text = '';
  } else {
    return null;
  }
  const after = replayedText(text, edits);
  return after === null ? null : { before: text, after, source: 'recorded' };
}

// Apply recorded edits to known text. Return null when an edit does not fit the text exactly.
function replayedText(start: string, edits: EditRecord[]): string | null {
  let text = start;
  for (const record of edits) {
    // A Write records the complete after side and replaces the accumulated text.
    if (typeof record.content === 'string') {
      text = record.content;
      continue;
    }
    if (record.patchInvalid) {
      return null;
    }
    if (!record.hunks.length) {
      continue;
    }
    if (!patchFitsRecordedText(text, record.hunks)) {
      return null;
    }
    // Copy hunks because applyPatch writes offsets onto them.
    // Preserve the hunks retained in the parsed transcript.
    const hunks = record.hunks.map((h) => ({ ...h, offset: 0 }));
    const applied = applyPatch(text, { hunks });
    // Reject failed patches and offset matches. Neither establishes an exact whole-file result.
    if (applied === false || hunks.some((hunk) => hunk.offset !== 0)) {
      return null;
    }
    text = applied;
  }
  return text;
}

// Build each changed region under its line-range header.
// Both sides contain recorded text without claiming whole-file coverage.
function changedRegions(edits: EditRecord[]): FileSides {
  const before: string[] = [];
  const after: string[] = [];
  for (const record of edits) {
    for (const hunk of record.hunks) {
      const header = hunkHeader(hunk);
      before.push(header);
      after.push(header);
      for (const line of hunk.lines) {
        // Include only context, removed, and added lines.
        // Exclude empty entries and the "No newline at end of file" marker from both sides.
        const text = line.slice(1);
        if (line.startsWith(' ') || line.startsWith('-')) {
          before.push(text);
        }
        if (line.startsWith(' ') || line.startsWith('+')) {
          after.push(text);
        }
      }
    }
  }
  return { before: before.join('\n'), after: after.join('\n'), source: 'hunks' };
}

// Build both sides from this turn's ordered file edits.
// Use whole files when available and changed regions otherwise.
export function sidesFor(edits: EditRecord[]): FileSides {
  if (!edits.length) {
    return { before: '', after: '', source: 'hunks' };
  }
  return wholeFiles(edits) ?? changedRegions(edits);
}

function usableSides(sides: FileSides): FileSides | null {
  return sides.source === 'recorded' || sides.before || sides.after ? sides : null;
}

// One contributor's recorded edits to one file, in its own record order.
// The span covers the contributor's turns that edited the file, in epoch milliseconds.
export interface FileContribution {
  edits: EditRecord[];
  startedAt?: number;
  endedAt?: number;
}

// Build one file's sides from the edits of every contributor behind it. Return null when no recorded text exists.
// Several contributors replay as one sequence only when their spans do not overlap and each contributor's first edit fits the text the earlier ones produced.
// Otherwise the sides hold changed regions in start order, because the record does not prove one whole-file sequence.
export function contributedFileSides(contributions: readonly FileContribution[]): FileSides | null {
  const present = contributions.filter((one) => one.edits.length);
  if (present.length <= 1) return usableSides(sidesFor(present[0]?.edits ?? []));
  const ordered = [...present].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0));
  const regions = (): FileSides | null => usableSides(changedRegions(ordered.flatMap((one) => one.edits)));
  const proven = ordered.every(
    (one, index) =>
      one.startedAt !== undefined &&
      one.endedAt !== undefined &&
      (index === 0 || (ordered[index - 1].endedAt ?? Infinity) <= one.startedAt),
  );
  const first = proven ? wholeFiles(ordered[0].edits) : null;
  if (!first) return regions();
  let text = first.after;
  for (const one of ordered.slice(1)) {
    const opening = one.edits[0];
    // A later contributor's first edit must name the text it started from, or change it with hunks that fit that text.
    // A complete write without the earlier text, or a creation over existing text, proves no continuity.
    if (typeof opening.originalFile === 'string') {
      if (opening.originalFile !== text) return regions();
    } else if (opening.isCreate ? text !== '' : typeof opening.content === 'string' || !opening.hunks.length) {
      return regions();
    }
    const next = replayedText(text, one.edits);
    if (next === null) return regions();
    text = next;
  }
  return { before: first.before, after: text, source: 'recorded' };
}
