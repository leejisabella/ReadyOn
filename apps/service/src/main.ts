import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ZodError } from 'zod';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config/env-schema';

/**
 * Service entrypoint. Parses env into a typed `ServiceConfig`, then composes
 * the app around it. Misconfiguration is surfaced as a single readable
 * stderr message — no half-started workers.
 *
 * @ref docs/04_Module_Plan.md §11
 * @ref docs/01_TRD.md §16
 */
async function bootstrap(): Promise<void> {
  const config = parseConfigOrExit();
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  app.enableShutdownHooks();
  await app.listen(config.server.port);
  Logger.log(`Time-Off service listening on :${config.server.port} (/graphql)`, 'Bootstrap');
}

function parseConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ZodError) {
      console.error('Invalid service configuration:');
      for (const issue of err.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      }
    } else {
      console.error('Fatal bootstrap error:', err);
    }
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
