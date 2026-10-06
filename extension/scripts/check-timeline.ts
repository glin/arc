import * as path from 'node:path';
import { sweepTimeline } from '../src/timelinecheck.ts';

async function main() {
  const args = process.argv.slice(2);
  let project = process.env.INIT_CWD || process.cwd();
  let now = Date.now();
  let days = 7;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--project') project = path.resolve(project, value);
    else if (flag === '--since' && /^[1-9][0-9]*d$/.test(value)) days = Number(value.slice(0, -1));
    else if (flag === '--now' && Number.isFinite(Date.parse(value))) now = Date.parse(value);
    else throw new Error(`Invalid argument: ${flag} ${value}`);
  }
  const report = await sweepTimeline(project, now - days * 86_400_000, now);
  for (const finding of report.violations) {
    const time = (at: number | undefined) => (at === undefined ? 'unavailable' : new Date(at).toISOString());
    console.log(
      `${finding.rule} ${finding.reason} session ${finding.session} turn ${finding.turn ?? 'unavailable'} child ${finding.child ?? 'unavailable'} close ${time(finding.close)} status ${finding.closeStatus ?? 'unavailable'} last work ${time(finding.lastWork)} file ${time(finding.writtenAt)}`,
    );
  }
  console.log(`Project ${report.project}`);
  console.log(`${report.sessions} sessions, ${report.violations.length} violations, ${report.unknown} unknown results`);
  if (args.includes('--now')) console.log(report.historicalWrites);
  process.exitCode = report.violations.length ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
