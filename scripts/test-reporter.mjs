import { writeFileSync } from 'node:fs';

const describe = (error) => error?.stack || error?.message || JSON.stringify(error);

// Retain suite and run errors alongside assertion results.
export default class TestReporter {
  onInit(ctx) {
    this.outputFile = process.env.ARC_TEST_RESULTS_FILE;
    this.lifecycleErrors = [];
    this.closureComplete = false;
    // Vitest logs swallowed close failures through this public logger method.
    const logError = ctx.logger.error.bind(ctx.logger);
    ctx.logger.error = (...args) => {
      if (args[0] === 'error during close') this.lifecycleErrors.push(describe(args[1]));
      return logError(...args);
    };
    ctx.onClose(() => {
      // The callback starts before other close promises settle. Observe the cached close promise afterwards.
      queueMicrotask(() => {
        ctx.close().then(
          () => {
            this.closureComplete = true;
          },
          (error) => {
            this.lifecycleErrors.push(describe(error));
          },
        );
      });
    });
    process.once('exit', () => {
      if (!this.outputFile) throw Error('Test diagnostics require an output path.');
      if (this.lifecycleErrors.length || !this.closureComplete) process.exitCode = 1;
      writeFileSync(
        this.outputFile,
        JSON.stringify({
          ...this.report,
          arcFailureAccounting: 2,
          closureComplete: Boolean(this.report) && this.closureComplete && !this.timedOut,
          lifecycleErrors: this.lifecycleErrors,
        }),
        { flag: 'wx' },
      );
    });
  }

  onProcessTimeout() {
    this.timedOut = true;
    this.lifecycleErrors.push('Test process closure timed out.');
    process.exitCode = 1;
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const testResults = modules.map((module) => {
      const assertionResults = [];
      const fileErrors = [];
      function visit(task, ancestors = []) {
        if (task.type === 'test') {
          assertionResults.push({
            fullName: [...ancestors, task.name].join(' '),
            status: task.result?.state === 'pass' ? 'passed' : task.result?.state === 'fail' ? 'failed' : 'skipped',
            failureMessages: (task.result?.errors ?? []).map(describe),
          });
        } else {
          for (const error of task.result?.errors ?? [])
            fileErrors.push({
              name: task === module.task ? '<module>' : [...ancestors, task.name].join(' '),
              detail: describe(error),
            });
          for (const child of task.tasks ?? [])
            visit(child, task === module.task ? ancestors : [...ancestors, task.name]);
        }
      }
      visit(module.task);
      return {
        name: module.task.filepath,
        status: module.task.result?.state === 'fail' ? 'failed' : 'passed',
        assertionResults,
        fileErrors,
      };
    });
    this.report = { reason, testResults, unhandledErrors: unhandledErrors.map(describe) };
  }
}
