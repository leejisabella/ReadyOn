import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { MockHcmModule } from './app.module';

/**
 * Mock HCM entrypoint. Runs in a separate process from the service.
 *
 * @ref docs/04_Module_Plan.md §4
 */
async function bootstrap(): Promise<void> {
  const dbPath = process.env.MOCK_HCM_DB_PATH ?? path.resolve(__dirname, '..', 'data', 'mock-hcm.sqlite');
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const app = await NestFactory.create(MockHcmModule.forRoot({ dbPath }), { bufferLogs: true });
  const port = Number(process.env.MOCK_HCM_PORT ?? 4000);
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`Mock HCM listening on :${port} (db=${dbPath})`, 'MockHcmBootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal Mock HCM bootstrap error', err);
  process.exit(1);
});
