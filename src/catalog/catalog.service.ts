import { Injectable } from '@nestjs/common';

import {
  Pagina,
  condicionKeyset,
  construirPagina,
  decodificarCursor,
} from '../common/pagination/keyset.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CategoriaApi, ClienteApi } from '../tickets/ticket.mapper.js';
import { ListClientsDto } from './dto/list-clients.dto.js';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listarClientes(filtros: ListClientsDto): Promise<Pagina<ClienteApi>> {
    const where: Prisma.ClientWhereInput = { deletedAt: null };
    if (filtros.isActive !== undefined) where.isActive = filtros.isActive;
    if (filtros.search !== undefined && filtros.search.trim() !== '') {
      // Resuelto por el índice GIN de trigramas sobre clients.name.
      where.name = { contains: filtros.search.trim(), mode: 'insensitive' };
    }

    if (filtros.cursor !== undefined) {
      const cursor = decodificarCursor(filtros.cursor);
      where.AND = [condicionKeyset('name', cursor, false, cursor.valor) as Prisma.ClientWhereInput];
    }

    const filas = await this.prisma.client.findMany({
      where,
      select: { id: true, name: true, taxId: true, email: true, phone: true, isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: filtros.limit + 1,
    });

    return construirPagina(filas, filtros.limit, (fila) => fila.name);
  }

  /**
   * Catálogo pequeño y estable: se devuelve entero, sin paginar. Paginar ocho
   * filas sería complejidad sin motivo.
   */
  async listarCategorias(): Promise<CategoriaApi[]> {
    return this.prisma.ticketCategory.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, defaultPriority: true, isActive: true },
      orderBy: { name: 'asc' },
    });
  }
}
