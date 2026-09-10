import { Injectable } from '@nestjs/common';

import { AppError } from '../common/problem/app-error.js';
import {
  Pagina,
  condicionKeyset,
  construirPagina,
  decodificarCursor,
} from '../common/pagination/keyset.js';
import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import { veTodosLosTickets } from '../auth/permissions.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ListTicketsDto, Orden } from './dto/list-tickets.dto.js';
import { ESTADOS_ABIERTOS } from './ticket-states.js';
import {
  SELECT_DETAIL,
  SELECT_SUMMARY,
  TicketDetail,
  TicketSummary,
  aDetail,
  aSummary,
} from './ticket.mapper.js';

/** Campo de base por el que ordena cada valor de `sort`. */
const CAMPO_DE_ORDEN: Record<Orden, 'createdAt' | 'lastActivityAt' | 'priority'> = {
  createdAt: 'createdAt',
  '-createdAt': 'createdAt',
  lastActivityAt: 'lastActivityAt',
  '-lastActivityAt': 'lastActivityAt',
  priority: 'priority',
  '-priority': 'priority',
};

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(filtros: ListTicketsDto, usuario: UsuarioPeticion): Promise<Pagina<TicketSummary>> {
    const campo = CAMPO_DE_ORDEN[filtros.sort];
    const descendente = filtros.sort.startsWith('-');

    const where = this.construirWhere(filtros, usuario);

    if (filtros.cursor !== undefined) {
      const cursor = decodificarCursor(filtros.cursor);
      const valor = campo === 'priority' ? cursor.valor : new Date(cursor.valor);
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        condicionKeyset(campo, cursor, descendente, valor) as Prisma.TicketWhereInput,
      ];
    }

    const direccion = descendente ? 'desc' : 'asc';
    const filas = await this.prisma.ticket.findMany({
      where,
      select: SELECT_SUMMARY,
      // El id desempata: sin él, dos filas con el mismo valor de orden podrían
      // repetirse o saltarse entre páginas.
      orderBy: [{ [campo]: direccion }, { id: direccion }],
      take: filtros.limit + 1,
    });

    const pagina = construirPagina(filas, filtros.limit, (fila) =>
      campo === 'priority' ? fila.priority : fila[campo].toISOString(),
    );

    return { data: pagina.data.map(aSummary), pageInfo: pagina.pageInfo };
  }

  async detalle(id: string, usuario: UsuarioPeticion): Promise<TicketDetail> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, deletedAt: null },
      select: SELECT_DETAIL,
    });

    // 404 y no 403 cuando existe pero no es visible: un 403 distinguible
    // confirma que el recurso existe y permite enumerar.
    if (ticket === null || !this.puedeVer(ticket.assignedTo?.id ?? null, usuario)) {
      throw AppError.noEncontrado('No existe un ticket con ese identificador.');
    }

    // El conteo solo aquí, nunca en el listado: en el detalle es un conteo sobre
    // una fila; en una tabla de 25 sería una agregación por fila en la ruta más
    // caliente de la aplicación.
    const commentCount = await this.prisma.ticketComment.count({
      where: { ticketId: id, deletedAt: null },
    });

    return aDetail(ticket, commentCount);
  }

  /**
   * Pertenencia, no solo rol. Un agente con permiso de lectura no puede ver
   * CUALQUIER ticket, solo los suyos: comprobar el rol y no la pertenencia es
   * el fallo de autorización más común que existe.
   */
  private puedeVer(asignadoA: string | null, usuario: UsuarioPeticion): boolean {
    if (veTodosLosTickets(usuario.roles)) return true;
    return asignadoA === usuario.id;
  }

  private construirWhere(
    filtros: ListTicketsDto,
    usuario: UsuarioPeticion,
  ): Prisma.TicketWhereInput {
    const where: Prisma.TicketWhereInput = { deletedAt: null };
    const condiciones: Prisma.TicketWhereInput[] = [];

    // El alcance se impone en el SERVIDOR, no se confía al cliente: un agente
    // solo ve sus tickets aunque pida los de otro.
    if (!veTodosLosTickets(usuario.roles)) {
      where.assignedToUserId = usuario.id;
    } else if (filtros.assignedToUserId !== undefined) {
      where.assignedToUserId =
        filtros.assignedToUserId === 'unassigned' ? null : filtros.assignedToUserId;
    }

    if (filtros.status !== undefined) where.status = { in: filtros.status };
    if (filtros.priority !== undefined) where.priority = { in: filtros.priority };
    if (filtros.clientId !== undefined) where.clientId = filtros.clientId;
    if (filtros.categoryId !== undefined) where.categoryId = filtros.categoryId;

    if (filtros.search !== undefined && filtros.search.trim() !== '') {
      const texto = filtros.search.trim();
      // El ILIKE '%texto%' sobre el título lo resuelve el índice GIN de
      // trigramas; sin él sería un seq scan sobre los 100.000.
      condiciones.push({
        OR: [
          { title: { contains: texto, mode: 'insensitive' } },
          { code: { contains: texto, mode: 'insensitive' } },
        ],
      });
    }

    if (filtros.staleHours !== undefined) {
      // Abiertos (definición única del contrato) sin actividad reciente, por
      // last_activity_at, que es el campo que sí cambia con un comentario.
      // Medido: con sort=lastActivityAt el planificador entra por el índice
      // parcial idx_tickets_stale (deduce que este IN implica status <> 'closed').
      // Con el orden por defecto prefiere idx_tickets_created_at_id: ~19% de la
      // tabla cumple el filtro y el LIMIT corta enseguida.
      condiciones.push({
        status: { in: [...ESTADOS_ABIERTOS] },
        lastActivityAt: { lt: new Date(Date.now() - filtros.staleHours * 3_600_000) },
      });
    }

    if (condiciones.length > 0) where.AND = condiciones;
    return where;
  }
}
