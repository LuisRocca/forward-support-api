// Escrituras sobre tickets. Cada una va en UNA transacción que cubre el cambio
// del ticket, su fila de historial, los contadores desnormalizados y
// last_activity_at. Sin transacción, reassignment_count empieza a mentir.
//
// Concurrencia optimista: los cambios de estado y de asignación actualizan con
// el valor que se leyó en el WHERE. Si otra petición lo cambió entre medias,
// no se actualiza ninguna fila y se responde 409 en vez de pisar el cambio.
import { Injectable } from '@nestjs/common';

import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import { veTodosLosTickets } from '../auth/permissions.js';
import { AppError } from '../common/problem/app-error.js';
import { CodigoError } from '../common/problem/problem.js';
import { Prisma } from '../generated/prisma/client.js';
import type { TicketStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AssignTicketDto,
  ChangeStatusDto,
  CreateTicketDto,
  UpdateTicketDto,
} from './dto/write-ticket.dto.js';
import {
  deshaceResolucion,
  esReapertura,
  esTransicionValida,
  requiereAdmin,
} from './status-transitions.js';
import { cargarTicketVisible } from './ticket-access.js';
import type { TicketDetail } from './ticket.mapper.js';
import { TicketsService } from './tickets.service.js';

function errorDeCampo(campo: string, mensaje: string): AppError {
  return new AppError(CodigoError.VALIDATION_ERROR, 422, 'Entrada inválida', mensaje, [
    { field: campo, message: mensaje },
  ]);
}

function esAdmin(usuario: UsuarioPeticion): boolean {
  return usuario.roles.includes('admin');
}

@Injectable()
export class TicketsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lectura: TicketsService,
  ) {}

  async crear(dto: CreateTicketDto, usuario: UsuarioPeticion): Promise<TicketDetail> {
    const puedeAsignar = veTodosLosTickets(usuario.roles);
    if (dto.assignedToUserId != null && !puedeAsignar) {
      throw AppError.prohibido('Solo admin y supervisor pueden asignar al crear.');
    }

    await this.validarCliente(dto.clientId);
    const categoria = dto.categoryId != null ? await this.validarCategoria(dto.categoryId) : null;

    // Un agente que abre un ticket se lo queda: si quedara sin asignar, el
    // agente no podría volver a verlo (solo ve sus asignados) justo después de
    // crearlo. Admin y supervisor pueden dejarlo en la bandeja de entrada.
    const asignado = puedeAsignar ? (dto.assignedToUserId ?? null) : usuario.id;
    if (asignado !== null && asignado !== usuario.id) await this.validarAsignable(asignado);

    const ahora = new Date();
    const id = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.create({
        data: {
          clientId: dto.clientId,
          categoryId: categoria?.id ?? null,
          title: dto.title,
          description: dto.description,
          // Sin prioridad explícita, la sugerida por la categoría.
          priority: dto.priority ?? categoria?.defaultPriority ?? 'medium',
          createdByUserId: usuario.id,
          assignedToUserId: asignado,
          assignedAt: asignado !== null ? ahora : null,
          lastActivityAt: ahora,
        },
        select: { id: true },
      });

      await tx.ticketStatusHistory.create({
        data: {
          ticketId: ticket.id,
          fromStatus: null,
          toStatus: 'open',
          changedByUserId: usuario.id,
          note: 'Ticket creado',
        },
      });

      if (asignado !== null) {
        // Asignación inicial: from_user_id NULL, no cuenta como reasignación.
        await tx.ticketAssignment.create({
          data: {
            ticketId: ticket.id,
            fromUserId: null,
            toUserId: asignado,
            assignedByUserId: usuario.id,
            reason: 'Asignación inicial',
          },
        });
      }

      return ticket.id;
    });

    return this.lectura.detalle(id, usuario);
  }

  async actualizar(id: string, dto: UpdateTicketDto, usuario: UsuarioPeticion): Promise<TicketDetail> {
    // Por valores y no por claves: con target ES2023 los campos de clase se
    // definen siempre, así que el DTO instanciado trae todas sus claves aunque
    // valgan undefined, y Object.keys(dto) nunca es 0.
    if (Object.values(dto).every((valor) => valor === undefined)) {
      throw new AppError(
        CodigoError.VALIDATION_ERROR,
        422,
        'Entrada inválida',
        'Envía al menos un campo que actualizar.',
      );
    }

    const ticket = await cargarTicketVisible(this.prisma, id, usuario);
    if (ticket.status === 'closed') {
      throw AppError.conflicto(
        'Un ticket cerrado no se edita. Solo un administrador puede reabrirlo.',
        CodigoError.TICKET_CLOSED,
      );
    }
    if (dto.categoryId != null) await this.validarCategoria(dto.categoryId);

    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        title: dto.title,
        description: dto.description,
        priority: dto.priority,
        categoryId: dto.categoryId,
        dueAt: dto.dueAt === undefined ? undefined : dto.dueAt === null ? null : new Date(dto.dueAt),
        lastActivityAt: new Date(),
      },
    });

    return this.lectura.detalle(id, usuario);
  }

  async cambiarEstado(
    id: string,
    dto: ChangeStatusDto,
    usuario: UsuarioPeticion,
  ): Promise<TicketDetail> {
    const ticket = await cargarTicketVisible(this.prisma, id, usuario);
    const desde = ticket.status;
    const hacia = dto.status;

    if (desde === hacia || !esTransicionValida(desde, hacia)) {
      throw AppError.conflicto(
        `No se puede pasar de ${desde} a ${hacia}.`,
        CodigoError.INVALID_STATUS_TRANSITION,
      );
    }
    // Rol, no estado: por eso 403 y no 409.
    if (requiereAdmin(desde, hacia) && !esAdmin(usuario)) {
      throw AppError.prohibido('Solo un administrador puede cerrar o reabrir tickets.');
    }

    const ahora = new Date();
    const data: Prisma.TicketUncheckedUpdateManyInput = {
      status: hacia,
      lastActivityAt: ahora,
      updatedAt: ahora,
      ...this.camposDeTransicion(desde, hacia, usuario.id, ahora),
    };

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { id: ticket.id, status: desde },
        data,
      });
      if (count === 0) throw this.cambioConcurrente();

      await tx.ticketStatusHistory.create({
        data: {
          ticketId: ticket.id,
          fromStatus: desde,
          toStatus: hacia,
          changedByUserId: usuario.id,
          note: dto.note ?? null,
        },
      });

      await this.marcarPrimeraRespuesta(tx, ticket.id, usuario.id);
    });

    return this.lectura.detalle(id, usuario);
  }

  async asignar(id: string, dto: AssignTicketDto, usuario: UsuarioPeticion): Promise<TicketDetail> {
    const ticket = await cargarTicketVisible(this.prisma, id, usuario);
    const previo = ticket.assignedToUserId;

    if (ticket.status === 'closed') {
      throw AppError.conflicto(
        'Un ticket cerrado no se reasigna. Solo un administrador puede reabrirlo.',
        CodigoError.TICKET_CLOSED,
      );
    }
    if (previo === dto.assignedToUserId) {
      throw AppError.conflicto('El ticket ya está asignado a ese usuario.');
    }
    await this.validarAsignable(dto.assignedToUserId);

    const ahora = new Date();
    await this.prisma.$transaction(async (tx) => {
      // El contador y la fila de historial van juntos: reassignment_count es
      // exactamente el número de filas con from_user_id NOT NULL.
      const { count } = await tx.ticket.updateMany({
        where: { id: ticket.id, assignedToUserId: previo },
        data: {
          assignedToUserId: dto.assignedToUserId,
          assignedAt: ahora,
          lastActivityAt: ahora,
          updatedAt: ahora,
          ...(previo !== null ? { reassignmentCount: { increment: 1 } } : {}),
        },
      });
      if (count === 0) throw this.cambioConcurrente();

      await tx.ticketAssignment.create({
        data: {
          ticketId: ticket.id,
          fromUserId: previo,
          toUserId: dto.assignedToUserId,
          assignedByUserId: usuario.id,
          reason: dto.reason ?? (previo === null ? 'Asignación inicial' : null),
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: usuario.id,
          action: 'ticket.assigned',
          entityType: 'ticket',
          entityId: ticket.id,
          metadata: { from: previo, to: dto.assignedToUserId },
        },
      });
    });

    return this.lectura.detalle(id, usuario);
  }

  /** Efectos colaterales de cada transición sobre las columnas del ticket. */
  private camposDeTransicion(
    desde: TicketStatus,
    hacia: TicketStatus,
    actor: string,
    ahora: Date,
  ): Prisma.TicketUncheckedUpdateManyInput {
    if (hacia === 'resolved') return { resolvedAt: ahora, resolvedByUserId: actor };
    if (hacia === 'closed') return { closedAt: ahora };

    // Deshacer una resolución borra su rastro en la fila: si no, las consultas
    // 4 y 5 contarían una resolución que ya no existe. El historial conserva
    // lo que pasó.
    const limpieza: Prisma.TicketUncheckedUpdateManyInput = deshaceResolucion(desde, hacia)
      ? { resolvedAt: null, resolvedByUserId: null, closedAt: null }
      : {};
    if (esReapertura(desde, hacia)) return { ...limpieza, reopenedCount: { increment: 1 } };
    return limpieza;
  }

  /**
   * first_response_at: la primera vez que alguien distinto de quien abrió el
   * ticket actúa sobre él. SQL directo para no tocar updated_at.
   */
  private async marcarPrimeraRespuesta(
    tx: Prisma.TransactionClient,
    ticketId: string,
    actor: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE tickets SET first_response_at = now()
      WHERE id = ${ticketId}::uuid AND first_response_at IS NULL
        AND created_by_user_id <> ${actor}::uuid`;
  }

  private cambioConcurrente(): AppError {
    return AppError.conflicto(
      'El ticket cambió mientras se procesaba la petición. Recárgalo y vuelve a intentarlo.',
    );
  }

  private async validarCliente(clientId: string): Promise<void> {
    const cliente = await this.prisma.client.findFirst({
      where: { id: clientId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (cliente === null) throw errorDeCampo('clientId', 'No existe un cliente activo con ese id.');
  }

  private async validarCategoria(
    categoryId: string,
  ): Promise<{ id: string; defaultPriority: 'low' | 'medium' | 'high' | 'critical' | null }> {
    const categoria = await this.prisma.ticketCategory.findFirst({
      where: { id: categoryId, isActive: true },
      select: { id: true, defaultPriority: true },
    });
    if (categoria === null) {
      throw errorDeCampo('categoryId', 'No existe una categoría activa con ese id.');
    }
    return categoria;
  }

  /** Solo se asigna a personal activo que atiende tickets: agente o supervisor. */
  private async validarAsignable(userId: string): Promise<void> {
    const usuario = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        status: 'active',
        roles: { some: { role: { code: { in: ['agent', 'supervisor'] } } } },
      },
      select: { id: true },
    });
    if (usuario === null) {
      throw errorDeCampo('assignedToUserId', 'No es un agente o supervisor activo.');
    }
  }
}
