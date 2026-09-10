import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { UsuarioActual } from '../auth/decorators/current-user.decorator.js';
import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import { RequierePermisos } from '../auth/decorators/permissions.decorator.js';
import { Permiso } from '../auth/permissions.js';
import type { Pagina } from '../common/pagination/keyset.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';
import { ListTicketsDto } from './dto/list-tickets.dto.js';
import {
  AssignTicketDto,
  ChangeStatusDto,
  CreateCommentDto,
  CreateTicketDto,
  UpdateTicketDto,
} from './dto/write-ticket.dto.js';
import { TicketActivityService } from './ticket-activity.service.js';
import type { ComentarioApi, EntradaHistorial } from './ticket-activity.service.js';
import type { TicketDetail, TicketSummary } from './ticket.mapper.js';
import { TicketsWriteService } from './tickets-write.service.js';
import { TicketsService } from './tickets.service.js';

const ID = new ParseUUIDPipe();

// Los permisos de rol van en el decorador; la PERTENENCIA (que el ticket sea
// del agente) se comprueba en el servicio, contra la fila concreta.
@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly escritura: TicketsWriteService,
    private readonly actividad: TicketActivityService,
  ) {}

  // Sin TICKET_LEER_TODOS: el agente también entra y el servicio le restringe
  // el alcance a sus tickets.
  @Get()
  async listar(
    @Query() filtros: ListTicketsDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<Pagina<TicketSummary>> {
    return this.tickets.listar(filtros, usuario);
  }

  @Post()
  @RequierePermisos(Permiso.TICKET_CREAR)
  async crear(
    @Body() dto: CreateTicketDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<TicketDetail> {
    return this.escritura.crear(dto, usuario);
  }

  @Get(':ticketId')
  async detalle(
    @Param('ticketId', ID) ticketId: string,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<TicketDetail> {
    return this.tickets.detalle(ticketId, usuario);
  }

  @Patch(':ticketId')
  @RequierePermisos(Permiso.TICKET_ACTUALIZAR)
  async actualizar(
    @Param('ticketId', ID) ticketId: string,
    @Body() dto: UpdateTicketDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<TicketDetail> {
    return this.escritura.actualizar(ticketId, dto, usuario);
  }

  @Post(':ticketId/status')
  @HttpCode(200)
  @RequierePermisos(Permiso.TICKET_CAMBIAR_ESTADO)
  async cambiarEstado(
    @Param('ticketId', ID) ticketId: string,
    @Body() dto: ChangeStatusDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<TicketDetail> {
    return this.escritura.cambiarEstado(ticketId, dto, usuario);
  }

  @Post(':ticketId/assign')
  @HttpCode(200)
  @RequierePermisos(Permiso.TICKET_ASIGNAR)
  async asignar(
    @Param('ticketId', ID) ticketId: string,
    @Body() dto: AssignTicketDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<TicketDetail> {
    return this.escritura.asignar(ticketId, dto, usuario);
  }

  @Get(':ticketId/comments')
  async comentarios(
    @Param('ticketId', ID) ticketId: string,
    @Query() filtros: ListCommentsDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<Pagina<ComentarioApi>> {
    return this.actividad.listarComentarios(ticketId, filtros, usuario);
  }

  @Post(':ticketId/comments')
  @RequierePermisos(Permiso.COMENTARIO_CREAR)
  async comentar(
    @Param('ticketId', ID) ticketId: string,
    @Body() dto: CreateCommentDto,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<ComentarioApi> {
    return this.actividad.comentar(ticketId, dto, usuario);
  }

  @Get(':ticketId/history')
  async historial(
    @Param('ticketId', ID) ticketId: string,
    @UsuarioActual() usuario: UsuarioPeticion,
  ): Promise<EntradaHistorial[]> {
    return this.actividad.historial(ticketId, usuario);
  }
}
