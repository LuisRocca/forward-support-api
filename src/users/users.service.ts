// Administración de usuarios. Bloquear es la operación que justifica medio
// modelo de auth: token_version y refresh_tokens existen para que un bloqueo
// surta efecto de inmediato y no cuando expire el JWT.
import { Injectable } from '@nestjs/common';

import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import type { ContextoPeticion } from '../auth/token.service.js';
import { AppError } from '../common/problem/app-error.js';
import {
  Pagina,
  condicionKeyset,
  construirPagina,
  decodificarCursor,
} from '../common/pagination/keyset.js';
import { Prisma } from '../generated/prisma/client.js';
import type { UserStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BlockUserDto, ListUsersDto } from './dto/users.dto.js';

export interface UsuarioApi {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  roles: string[];
  lastLoginAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  createdAt: string;
}

/** `password_hash` y `token_version` quedan fuera: no salen nunca de la API. */
const SELECT_USUARIO = {
  id: true,
  email: true,
  fullName: true,
  status: true,
  lastLoginAt: true,
  blockedAt: true,
  blockedReason: true,
  createdAt: true,
  roles: { select: { role: { select: { code: true } } } },
} as const;

type FilaUsuario = Prisma.UserGetPayload<{ select: typeof SELECT_USUARIO }>;

function aUsuario(fila: FilaUsuario): UsuarioApi {
  return {
    id: fila.id,
    email: fila.email,
    fullName: fila.fullName,
    status: fila.status,
    roles: fila.roles.map((r) => r.role.code),
    lastLoginAt: fila.lastLoginAt?.toISOString() ?? null,
    blockedAt: fila.blockedAt?.toISOString() ?? null,
    blockedReason: fila.blockedReason,
    createdAt: fila.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(filtros: ListUsersDto): Promise<Pagina<UsuarioApi>> {
    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (filtros.status !== undefined) where.status = filtros.status;
    if (filtros.roleCode !== undefined) {
      where.roles = { some: { role: { code: filtros.roleCode } } };
    }
    if (filtros.cursor !== undefined) {
      const cursor = decodificarCursor(filtros.cursor);
      where.AND = [condicionKeyset('fullName', cursor, false, cursor.valor) as Prisma.UserWhereInput];
    }

    const filas = await this.prisma.user.findMany({
      where,
      select: SELECT_USUARIO,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: filtros.limit + 1,
    });

    const pagina = construirPagina(filas, filtros.limit, (fila) => fila.fullName);
    return { data: pagina.data.map(aUsuario), pageInfo: pagina.pageInfo };
  }

  /**
   * Las tres cosas juntas y en una transacción, porque por separado ninguna
   * basta:
   *   1. status = blocked: el login lo rechaza.
   *   2. token_version++: todo access token emitido deja de valer en la
   *      siguiente petición, sin esperar a que expire.
   *   3. revocar los refresh tokens: no puede renovar la sesión.
   */
  async bloquear(
    userId: string,
    dto: BlockUserDto,
    admin: UsuarioPeticion,
    contexto: ContextoPeticion,
  ): Promise<UsuarioApi> {
    // Un admin que se bloquea a sí mismo puede dejar el sistema sin nadie que
    // desbloquee. Es una petición válida contra un estado que no la admite: 409.
    if (userId === admin.id) throw AppError.conflicto('No puedes bloquearte a ti mismo.');

    const usuario = await this.buscar(userId);
    if (usuario.status === 'blocked') throw AppError.conflicto('El usuario ya está bloqueado.');

    const ahora = new Date();
    const actualizado = await this.prisma.$transaction(async (tx) => {
      const fila = await tx.user.update({
        where: { id: userId },
        data: {
          status: 'blocked',
          blockedAt: ahora,
          blockedByUserId: admin.id,
          blockedReason: dto.reason,
          tokenVersion: { increment: 1 },
        },
        select: SELECT_USUARIO,
      });

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: ahora, revokedReason: 'user_blocked' },
      });

      await this.auditar(tx, admin.id, 'user.blocked', userId, contexto, { reason: dto.reason });
      return fila;
    });

    return aUsuario(actualizado);
  }

  /**
   * No toca token_version: las sesiones anteriores ya murieron al bloquear y el
   * usuario tendrá que iniciar sesión de nuevo. Tampoco toca el bloqueo por
   * intentos fallidos, que es otro mecanismo con su propia caducidad.
   */
  async desbloquear(
    userId: string,
    admin: UsuarioPeticion,
    contexto: ContextoPeticion,
  ): Promise<UsuarioApi> {
    const usuario = await this.buscar(userId);
    if (usuario.status !== 'blocked') throw AppError.conflicto('El usuario no está bloqueado.');

    const actualizado = await this.prisma.$transaction(async (tx) => {
      const fila = await tx.user.update({
        where: { id: userId },
        data: { status: 'active', blockedAt: null, blockedByUserId: null, blockedReason: null },
        select: SELECT_USUARIO,
      });
      await this.auditar(tx, admin.id, 'user.unblocked', userId, contexto, null);
      return fila;
    });

    return aUsuario(actualizado);
  }

  private async buscar(userId: string): Promise<{ status: UserStatus }> {
    const usuario = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { status: true },
    });
    if (usuario === null) throw AppError.noEncontrado('No existe un usuario con ese identificador.');
    return usuario;
  }

  /** Sin tokens ni contraseñas en metadata: la tabla se consulta y se exporta. */
  private async auditar(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    action: string,
    entityId: string,
    contexto: ContextoPeticion,
    metadata: Record<string, string> | null,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType: 'user',
        entityId,
        ipAddress: contexto.ip ?? null,
        userAgent: contexto.userAgent?.slice(0, 255) ?? null,
        metadata: metadata ?? undefined,
      },
    });
  }
}
