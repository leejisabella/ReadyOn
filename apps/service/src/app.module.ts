import { Module } from '@nestjs/common';

/**
 * Root module of the ReadyOn Time-Off service.
 *
 * Wires every feature module per Module Plan §2:
 *   ConfigModule → DatabaseModule → Api/Domain/Infrastructure/Worker modules.
 *
 * @ref docs/04_Module_Plan.md §2
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
