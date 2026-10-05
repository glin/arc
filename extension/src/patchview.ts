import { applyPatch } from 'diff';
import { patchMarkersAreValid, type EditRecord } from './transcript';

// Builds the two sides of one file's diff for a single turn, out of what the transcript
// recorded and nothing else.
//
// The after side is never read from the file on disk. The file has moved on since the turn
// ran: later turns, the user, a formatter or a parallel agent may all have written to it,
// and none of that belongs to this turn. Reading it would put a confident wrong answer on
// screen, so both sides come from the recorded text, and the caller is told which of the
// two routes produced them.

// Whether the two sides are the whole files or only the changed regions.
export type DiffSource = 'recorded' | 'hunks';

export interface FileSides {
  before: string;
  after: string;
  source: DiffSource;
}

// The header the hunks route puts above each region, naming the lines it covers, in the
// shape a unified diff writes it.
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

// Both whole files, when the records carry enough to rebuild them, or null when they do
// not and the caller has to fall back.
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
    // A Write records the whole after side, so it replaces the running text outright.
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
    // A copy, because `applyPatch` writes an offset onto each hunk it is handed and these
    // hunks belong to the parsed transcript the panel keeps.
    const hunks = record.hunks.map((h) => ({ ...h, offset: 0 }));
    const applied = applyPatch(text, { hunks });
    // The patch does not fit the text it was recorded against, so the whole-file answer
    // would be wrong rather than merely partial. This fires on real recorded data.
    if (applied === false || hunks.some((hunk) => hunk.offset !== 0)) {
      return null;
    }
    text = applied;
  }
  return { before, after: text, source: 'recorded' };
}

// Only the regions the turn changed, each under a header naming its line range. Both sides
// are text the transcript recorded, so neither claims to be the whole file.
function changedRegions(edits: EditRecord[]): FileSides {
  const before: string[] = [];
  const after: string[] = [];
  for (const record of edits) {
    for (const hunk of record.hunks) {
      const header = hunkHeader(hunk);
      before.push(header);
      after.push(header);
      for (const line of hunk.lines) {
        // The first character says which side the line belongs to, so an entry carrying
        // none of the three reaches neither side. That is what keeps the patch's
        // "\ No newline at end of file" note, which describes the file rather than being a
        // line of it, out of the text on both sides, and an empty entry out of it too.
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

// The before and after sides of one file, from every edit the turn made to it, in order.
// Whole files when the records carry them, the changed regions alone otherwise.
export function sidesFor(edits: EditRecord[]): FileSides {
  if (!edits.length) {
    return { before: '', after: '', source: 'hunks' };
  }
  return wholeFiles(edits) ?? changedRegions(edits);
}
