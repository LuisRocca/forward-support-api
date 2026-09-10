import { Module } from '@nestjs/common';

import { TicketActivityService } from './ticket-activity.service.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsWriteService } from './tickets-write.service.js';
import { TicketsService } from './tickets.service.js';

@Module({
  controllers: [TicketsController],
  providers: [TicketsService, TicketsWriteService, TicketActivityService],
})
export class TicketsModule {}
