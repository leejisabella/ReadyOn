import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';

/** Test-driving surface (`/admin/*`). Backed entirely by the shared stores. */
@Module({
  controllers: [AdminController],
})
export class AdminModule {}
