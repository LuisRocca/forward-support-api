import { Controller, Get, Header, Query } from '@nestjs/common';

import { RequierePermisos } from '../auth/decorators/permissions.decorator.js';
import { Permiso } from '../auth/permissions.js';
import type { Pagina } from '../common/pagination/keyset.js';
import type { CategoriaApi, ClienteApi } from '../tickets/ticket.mapper.js';
import { CatalogService } from './catalog.service.js';
import { ListClientsDto } from './dto/list-clients.dto.js';

@Controller()
export class CatalogController {
  constructor(private readonly catalogo: CatalogService) {}

  @Get('clients')
  @RequierePermisos(Permiso.CLIENTE_LEER)
  async clientes(@Query() filtros: ListClientsDto): Promise<Pagina<ClienteApi>> {
    return this.catalogo.listarClientes(filtros);
  }

  @Get('ticket-categories')
  // Catálogo pequeño y estable: se cachea para que el front no lo vuelva a
  // pedir en cada carga de formulario. `private` porque va tras autenticación.
  @Header('Cache-Control', 'private, max-age=300')
  async categorias(): Promise<CategoriaApi[]> {
    return this.catalogo.listarCategorias();
  }
}
