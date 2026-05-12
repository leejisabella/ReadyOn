import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Service entrypoint. AppModule.forRoot composes the full stack; this file
 * owns lifecycle and env → options translation only.
 *
 * @ref docs/04_Module_Plan.md §11
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(
    AppModule.forRoot({
      dbPath: process.env.DB_PATH ?? './time-off.db',
      hcmBaseUrl: process.env.HCM_BASE_URL ?? 'http://localhost:4000',
      hcmTimeoutMs: process.env.HCM_TIMEOUT_MS
        ? Number(process.env.HCM_TIMEOUT_MS)
        : undefined,
      breakGlassMinOutageMs: process.env.BREAK_GLASS_MIN_OUTAGE_MS
        ? Number(process.env.BREAK_GLASS_MIN_OUTAGE_MS)
        : undefined,
    }),
    { bufferLogs: true },
  );
  const port = Number(process.env.PORT ?? 3000);
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`Time-Off service listening on :${port} (/graphql)`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
