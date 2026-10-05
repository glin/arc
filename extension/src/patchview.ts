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
  const before = text;
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
  return { before, after: text, source: 'recorded' };
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
