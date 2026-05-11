import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { MockHcmModule } from './app.module';

/**
 * Mock HCM entrypoint. Runs in a separate process from the service.
 *
 * @ref docs/04_Module_Plan.md §4
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(MockHcmModule, { bufferLogs: true });
  const port = Number(process.env.MOCK_HCM_PORT ?? 4000);
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`Mock HCM listening on :${port}`, 'MockHcmBootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal Mock HCM bootstrap error', err);
  process.exit(1);
});
