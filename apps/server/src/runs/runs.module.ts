import { Module } from '@nestjs/common';

import { RunsController } from './runs.controller';
import { RunStreamController } from './run-stream.controller';
import { RunsService } from './runs.service';

@Module({
  controllers: [RunsController, RunStreamController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
