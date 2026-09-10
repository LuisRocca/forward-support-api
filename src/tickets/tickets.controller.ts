import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';

import { UsuarioActual } from '../auth/decorators/current-user.decorator.js';
import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import type { Pagina } from '../common/pagination/keyset.js';
import { ListTicketsDto } from './dto/list-tickets.dto.js';
import type { TicketDetail, TicketSummary } from './ticket.mapper.js';
import { TicketsService } from './tickets.service.js';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  // No se exige TICKET_LEER_TODOS: el agente también entra aquí, y el servicio
  // le restringe el alcance a sus propios tickets.
  @Get()
  async listar(
    @Query() filtros: ListTicketsDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<Pagina<TicketSummary>> {
    return this.tickets.listar(filtros, usuario);
  }

  @Get(':ticketId')
  async detalle(
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<TicketDetail> {
    return this.tickets.detalle(ticketId, usuario);
  }
}
