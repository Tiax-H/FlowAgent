import { Module } from '@nestjs/common';

import { EventStore } from '../engine/event-store.service';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  controllers: [RunsController],
  providers: [RunsService, EventStore],
  exports: [RunsService],
})
export class RunsModule {}
