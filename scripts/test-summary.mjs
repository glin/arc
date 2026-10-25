import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const lines = ['| Category | Result | Exit status |', '| --- | --- | --- |'];
for (const entry of readdirSync(directory)) {
  const file = join(directory, entry, 'suite.json');
  if (!entry.startsWith('arc-') || !existsSync(file)) continue;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const category of report.categories)
    lines.push(`| ${category.id} | ${category.status} | ${category.exitCode ?? ''} |`);
}
if (lines.length === 2) lines.push('| Test collection | incomplete | |');
const summary = lines.join('\n') + '\n';
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
