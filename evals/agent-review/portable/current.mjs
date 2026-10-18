import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, copyInputs, qualifyAsync, root, sha } from './core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const currentId = 'current-hooks-001';
const sourcePath = 'scripts/register-hooks.js';
const original = 'const owned = target === `${currentLegacyDir}/${path.posix.basename(target)}`;';
const mutated = 'const owned = true;';

export function currentRecipe(checkout = root) {
  const source = fs.readFileSync(path.join(checkout, sourcePath), 'utf8');
  assert(source.split(original).length === 2 && !source.includes(mutated), 'current recipe precondition changed');
  const candidate = source.replace(original, mutated);
  const script = path.join(here, 'current', 'qualify-hooks.mjs');
  const item = {
    id: currentId,
    family: 'interaction-routing',
    kind: 'bug',
    split: 'development',
    source_mode: 'current',
    revision: 1,
    title: 'Legacy hook migration',
    keys: [
      {
        id: 'unrelated-hook-removed',
        severity: 'medium',
        summary: 'Legacy hook migration removes an unrelated command in the same hook group.',
        paths: [sourcePath],
        scenario: 'A source install removes a user hook that shares a group with an old Arc hook.',
      },
    ],
    inputs: [{ path: sourcePath, sha256: sha(candidate) }],
    source_sha256: sha(source),
    recipe_sha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    prompt_sha256: sha(
      'Review the candidate hook registration change for material defects. Report file, severity, scenario, and evidence.\n',
    ),
    diff_sha256: sha(`--- a/${sourcePath}\n+++ b/${sourcePath}\n@@\n-${original}\n+${mutated}\n`),
  };
  return { item, candidate, source, script };
}

export async function prepareCurrent(recipe, workspace, instructions, signal) {
  const reference = fs.mkdtempSync(path.join(path.dirname(workspace), 'reference-'));
  try {
    const input = path.join(reference, sourcePath);
    fs.mkdirSync(path.dirname(input), { recursive: true });
    fs.writeFileSync(input, recipe.source);
    const candidateRoot = fs.mkdtempSync(path.join(path.dirname(workspace), 'candidate-'));
    try {
      const candidatePath = path.join(candidateRoot, sourcePath);
      fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
      fs.writeFileSync(candidatePath, recipe.candidate);
      copyInputs(candidateRoot, workspace, recipe.item.inputs);
    } finally {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
    }
    for (const doc of instructions) {
      const dest = path.join(workspace, 'context', doc.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, doc.bytes, { flag: 'wx' });
    }
    const qualification = await qualifyAsync(recipe.script, workspace, reference, 'bug', signal);
    return {
      prompt:
        'Review the candidate hook registration change for material defects. Report file, severity, scenario, and evidence.\n',
      diff: `--- a/${sourcePath}\n+++ b/${sourcePath}\n@@\n-${original}\n+${mutated}\n`,
      qualification,
      inventory: recipe.item.inputs,
      sourceMode: 'current',
      caseHash: sha(JSON.stringify(recipe.item)),
    };
  } finally {
    fs.rmSync(reference, { recursive: true, force: true });
  }
}
