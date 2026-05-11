import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Service entrypoint.
 *
 * Boots the Nest app and binds to the configured port. Module wiring (config,
 * database, workers) happens inside AppModule; this file owns lifecycle only.
 *
 * @ref docs/04_Module_Plan.md §11
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const port = Number(process.env.PORT ?? 3000);
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`Time-Off service listening on :${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
