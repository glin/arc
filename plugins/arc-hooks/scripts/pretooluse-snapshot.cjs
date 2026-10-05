#!/usr/bin/env node
// plugins/arc-hooks/scripts/pretooluse-snapshot.cjs
const path = require('node:path');
const lib = require('./lib.js');

let raw = '';
process.stdin.on('data', (data) => {
  raw += data;
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const sessionId = input.session_id;
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path || toolInput.notebook_path;
    if (sessionId && filePath) {
      const absolutePath = path.resolve(input.cwd || process.cwd(), filePath);
      lib.recordBaseline(sessionId, absolutePath, input.cwd);
    }
  } catch {
    // A snapshot failure must not block the file-edit tool.
  }
  process.exit(0);
});
