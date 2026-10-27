import { createApp } from './app.ts';
import { readConfig } from './config.ts';

try {
  const config = readConfig();
  const server = createApp(config);
  server.on('error', () => { console.error('Honeycomb server failed to listen'); process.exitCode = 1; });
  server.listen(config.port, '0.0.0.0', () => console.log(`Honeycomb listening on port ${config.port}`));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid startup configuration');
  process.exitCode = 1;
}
