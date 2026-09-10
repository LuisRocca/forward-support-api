import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { UsuarioActual } from '../auth/decorators/current-user.decorator.js';
import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import { RequierePermisos } from '../auth/decorators/permissions.decorator.js';
import { Permiso } from '../auth/permissions.js';
import type { Pagina } from '../common/pagination/keyset.js';
import { BlockUserDto, ListUsersDto } from './dto/users.dto.js';
import { UsersService } from './users.service.js';
import type { UsuarioApi } from './users.service.js';

const ID = new ParseUUIDPipe();

@Controller('users')
export class UsersController {
  constructor(private readonly usuarios: UsersService) {}

  @Get()
  @RequierePermisos(Permiso.USUARIO_LEER)
  async listar(@Query() filtros: ListUsersDto): Promise<Pagina<UsuarioApi>> {
    return this.usuarios.listar(filtros);
  }

  // USUARIO_BLOQUEAR solo lo tiene el admin.
  @Post(':userId/block')
  @HttpCode(200)
  @RequierePermisos(Permiso.USUARIO_BLOQUEAR)
  async bloquear(
    @Param('userId', ID) userId: string,
    @Body() dto: BlockUserDto,
    @UsuarioActual() admin: UsuarioPeticion,
    @Req() peticion: Request,
  ): Promise<UsuarioApi> {
    return this.usuarios.bloquear(userId, dto, admin, this.contexto(peticion));
  }

  @Post(':userId/unblock')
  @HttpCode(200)
  @RequierePermisos(Permiso.USUARIO_BLOQUEAR)
  async desbloquear(
    @Param('userId', ID) userId: string,
    @UsuarioActual() admin: UsuarioPeticion,
    @Req() peticion: Request,
  ): Promise<UsuarioApi> {
    return this.usuarios.desbloquear(userId, admin, this.contexto(peticion));
  }

  private contexto(peticion: Request): { ip: string | null; userAgent: string | null } {
    return { ip: peticion.ip ?? null, userAgent: peticion.headers['user-agent'] ?? null };
  }
}
