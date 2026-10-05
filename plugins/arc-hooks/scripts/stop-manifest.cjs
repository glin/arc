#!/usr/bin/env node
// plugins/arc-hooks/scripts/stop-manifest.cjs
const lib = require('./lib.js');

let raw = '';
process.stdin.on('data', (data) => {
  raw += data;
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const sessionId = input.session_id;
    if (sessionId) {
      const title = lib.readSessionTitle(input.transcript_path);
      lib.publishManifest(sessionId, input.cwd, title);
    }
  } catch {
    // A manifest failure must not block the agent from finishing.
  }
  process.exit(0);
});
