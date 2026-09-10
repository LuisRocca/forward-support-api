// Comentarios e historial de un ticket.
import { Injectable } from '@nestjs/common';

import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import { Permiso, tienePermiso } from '../auth/permissions.js';
import { AppError } from '../common/problem/app-error.js';
import {
  Pagina,
  condicionKeyset,
  construirPagina,
  decodificarCursor,
} from '../common/pagination/keyset.js';
import { Prisma } from '../generated/prisma/client.js';
import type { TicketStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateCommentDto } from './dto/write-ticket.dto.js';
import type { ListCommentsDto } from './dto/list-comments.dto.js';
import { cargarTicketVisible } from './ticket-access.js';
import type { UserRef } from './ticket.mapper.js';

export interface ComentarioApi {
  id: string;
  body: string;
  isInternal: boolean;
  author: UserRef;
  createdAt: string;
}

export interface EntradaHistorial {
  type: 'status_change' | 'assignment';
  actor: UserRef;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus | null;
  fromUser: UserRef | null;
  toUser: UserRef | null;
  note: string | null;
  occurredAt: string;
}

const SELECT_COMENTARIO = {
  id: true,
  body: true,
  isInternal: true,
  createdAt: true,
  author: { select: { id: true, fullName: true } },
} as const;

function aComentario(fila: {
  id: string;
  body: string;
  isInternal: boolean;
  createdAt: Date;
  author: UserRef;
}): ComentarioApi {
  return { ...fila, createdAt: fila.createdAt.toISOString() };
}

@Injectable()
export class TicketActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async listarComentarios(
    ticketId: string,
    filtros: ListCommentsDto,
    usuario: UsuarioPeticion,
  ): Promise<Pagina<ComentarioApi>> {
    await cargarTicketVisible(this.prisma, ticketId, usuario);

    const where: Prisma.TicketCommentWhereInput = { ticketId, deletedAt: null };
    // Los internos se filtran EN LA CONSULTA para quien no debe verlos: enviarlos
    // al navegador y ocultarlos por CSS es una filtración. Hoy todo el personal
    // tiene el permiso (ver permissions.ts), pero el filtro ya está donde tiene
    // que estar para el día que un rol no lo tenga.
    if (!tienePermiso(usuario.roles, Permiso.COMENTARIO_LEER_INTERNOS)) where.isInternal = false;

    if (filtros.cursor !== undefined) {
      const cursor = decodificarCursor(filtros.cursor);
      where.AND = [
        condicionKeyset('createdAt', cursor, false, new Date(cursor.valor)) as Prisma.TicketCommentWhereInput,
      ];
    }

    const filas = await this.prisma.ticketComment.findMany({
      where,
      select: SELECT_COMENTARIO,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: filtros.limit + 1,
    });

    const pagina = construirPagina(filas, filtros.limit, (fila) => fila.createdAt.toISOString());
    return { data: pagina.data.map(aComentario), pageInfo: pagina.pageInfo };
  }

  async comentar(
    ticketId: string,
    dto: CreateCommentDto,
    usuario: UsuarioPeticion,
  ): Promise<ComentarioApi> {
    const ticket = await cargarTicketVisible(this.prisma, ticketId, usuario);

    const interno = dto.isInternal ?? false;
    if (interno && !usuario.roles.some((rol) => rol === 'admin' || rol === 'supervisor')) {
      throw AppError.prohibido('Solo admin y supervisor pueden añadir comentarios internos.');
    }

    const comentario = await this.prisma.$transaction(async (tx) => {
      const creado = await tx.ticketComment.create({
        data: { ticketId: ticket.id, authorUserId: usuario.id, body: dto.body, isInternal: interno },
        select: SELECT_COMENTARIO,
      });

      // SQL directo y no ticket.update(): el cliente de Prisma rellena
      // updated_at solo (@updatedAt) en cualquier update, y un comentario NO
      // modifica el ticket. Que updated_at no se mueva con un comentario es
      // exactamente por lo que existe last_activity_at (consulta 3).
      await tx.$executeRaw`
        UPDATE tickets
        SET last_activity_at = now(),
            first_response_at = coalesce(
              first_response_at,
              CASE WHEN created_by_user_id <> ${usuario.id}::uuid THEN now() END)
        WHERE id = ${ticket.id}::uuid`;

      return creado;
    });

    return aComentario(comentario);
  }

  /** Estados y reasignaciones, fusionados en orden cronológico. */
  async historial(ticketId: string, usuario: UsuarioPeticion): Promise<EntradaHistorial[]> {
    await cargarTicketVisible(this.prisma, ticketId, usuario);

    const ref = { select: { id: true, fullName: true } } as const;
    const [estados, asignaciones] = await Promise.all([
      this.prisma.ticketStatusHistory.findMany({
        where: { ticketId },
        select: { fromStatus: true, toStatus: true, note: true, changedAt: true, changedBy: ref },
      }),
      this.prisma.ticketAssignment.findMany({
        where: { ticketId },
        select: { reason: true, assignedAt: true, assignedBy: ref, fromUser: ref, toUser: ref },
      }),
    ]);

    const entradas: EntradaHistorial[] = [
      ...estados.map((e) => ({
        type: 'status_change' as const,
        actor: e.changedBy,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        fromUser: null,
        toUser: null,
        note: e.note,
        occurredAt: e.changedAt.toISOString(),
      })),
      ...asignaciones.map((a) => ({
        type: 'assignment' as const,
        actor: a.assignedBy,
        fromStatus: null,
        toStatus: null,
        fromUser: a.fromUser,
        toUser: a.toUser,
        note: a.reason,
        occurredAt: a.assignedAt.toISOString(),
      })),
    ];

    return entradas.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}
