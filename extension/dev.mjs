import { createServer } from 'vite';
import { buildExtension } from './esbuild.mjs';

const developmentServerUrl = 'http://127.0.0.1:5173';
const server = await createServer();
let stopBuild = async () => undefined;

try {
  await server.listen();
  stopBuild = await buildExtension({ watch: true, developmentServerUrl });
  server.printUrls();
  console.log('Arc development build is ready. Open or reload the Extension Development Host.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
} finally {
  await stopBuild();
  await server.close();
}
