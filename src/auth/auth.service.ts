import { Injectable } from '@nestjs/common';

import { AppError } from '../common/problem/app-error.js';
import { EnvService } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import type { ContextoPeticion } from './token.service.js';
import { permisosDe } from './permissions.js';

/** Lo que devuelven login y refresh, ya con la forma del contrato. */
export interface Sesion {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: UsuarioAutenticado;
}

export interface UsuarioAutenticado {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: string[];
  permissions: string[];
  lastLoginAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  createdAt: string;
}

/**
 * Campos que se leen de users. `password_hash` NUNCA está aquí: se selecciona
 * explícitamente y solo en el login.
 */
const CAMPOS_PUBLICOS = {
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly env: EnvService,
  ) {}

  async login(email: string, password: string, contexto: ContextoPeticion): Promise<Sesion> {
    // El email es citext: la búsqueda ya es insensible a mayúsculas en la base.
    const usuario = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        ...CAMPOS_PUBLICOS,
        passwordHash: true,
        tokenVersion: true,
        failedLoginAttempts: true,
        lockedUntil: true,
      },
    });

    if (usuario === null) {
      // Se audita el intento aunque el usuario no exista, pero la respuesta es
      // la misma que con contraseña incorrecta.
      await this.auditar(null, 'auth.login_failed', contexto, { reason: 'unknown_email' });
      throw AppError.credencialesInvalidas();
    }

    // Bloqueo automático por fuerza bruta. Deliberadamente separado de
    // status='blocked', que es administrativo: si se mezclaran, un ataque de
    // fuerza bruta contra un admin lo dejaría bloqueado y haría falta otro
    // admin para restaurarlo.
    if (usuario.lockedUntil !== null && usuario.lockedUntil.getTime() > Date.now()) {
      await this.auditar(usuario.id, 'auth.login_failed', contexto, { reason: 'locked' });
      throw AppError.cuentaBloqueada(
        'Demasiados intentos fallidos. Vuelve a probar más tarde.',
      );
    }

    if (usuario.status !== 'active') {
      await this.auditar(usuario.id, 'auth.login_failed', contexto, { reason: usuario.status });
      throw AppError.cuentaBloqueada(
        usuario.blockedReason ?? 'La cuenta no está activa. Contacta con un administrador.',
      );
    }

    const correcta = await this.passwords.verificar(usuario.passwordHash, password);
    if (!correcta) {
      await this.registrarFallo(usuario.id, usuario.failedLoginAttempts, contexto);
      throw AppError.credencialesInvalidas();
    }

    const roles = usuario.roles.map((r) => r.role.code);

    const [access, refresh] = await Promise.all([
      this.tokens.emitirAccessToken({
        sub: usuario.id,
        tokenVersion: usuario.tokenVersion,
        roles,
      }),
      this.tokens.emitirRefreshToken(usuario.id, contexto),
    ]);

    const actualizado = await this.prisma.user.update({
      where: { id: usuario.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
      select: CAMPOS_PUBLICOS,
    });

    await this.auditar(usuario.id, 'auth.login_success', contexto, null);

    return {
      accessToken: access.token,
      expiresIn: access.expiraEn,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiraEn,
      user: this.aUsuarioAutenticado(actualizado),
    };
  }

  async refresh(tokenPlano: string, contexto: ContextoPeticion): Promise<Sesion> {
    const rotado = await this.tokens.rotar(tokenPlano, contexto);
    if (rotado === null) {
      throw AppError.tokenRevocado('La sesión no es válida. Vuelve a iniciar sesión.');
    }

    const usuario = await this.prisma.user.findFirst({
      where: { id: rotado.userId, deletedAt: null },
      select: { ...CAMPOS_PUBLICOS, tokenVersion: true },
    });

    // Un usuario bloqueado no puede renovar, aunque su refresh siga vivo.
    if (usuario === null || usuario.status !== 'active') {
      await this.tokens.revocarTodasLasSesiones(rotado.userId, 'user_blocked');
      throw AppError.usuarioBloqueado(usuario?.blockedReason ?? null);
    }

    const roles = usuario.roles.map((r) => r.role.code);
    const access = await this.tokens.emitirAccessToken({
      sub: usuario.id,
      tokenVersion: usuario.tokenVersion,
      roles,
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiraEn,
      refreshToken: rotado.refresh.token,
      refreshExpiresIn: rotado.refresh.expiraEn,
      user: this.aUsuarioAutenticado(usuario),
    };
  }

  async logout(tokenPlano: string | undefined): Promise<void> {
    if (tokenPlano === undefined) return;
    await this.tokens.revocarPorToken(tokenPlano, 'logout');
  }

  async usuarioAutenticado(userId: string): Promise<UsuarioAutenticado> {
    const usuario = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: CAMPOS_PUBLICOS,
    });
    if (usuario === null) throw AppError.tokenRevocado();
    return this.aUsuarioAutenticado(usuario);
  }

  /**
   * Suma un intento fallido y bloquea temporalmente al llegar al umbral.
   * El contador se reinicia en el próximo login correcto.
   */
  private async registrarFallo(
    userId: string,
    fallosPrevios: number,
    contexto: ContextoPeticion,
  ): Promise<void> {
    const fallos = fallosPrevios + 1;
    const superaUmbral = fallos >= this.env.maxIntentosFallidos;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: fallos,
        lockedUntil: superaUmbral
          ? new Date(Date.now() + this.env.bloqueoMinutos * 60_000)
          : null,
      },
    });

    await this.auditar(userId, 'auth.login_failed', contexto, {
      reason: 'bad_password',
      attempts: fallos,
      locked: superaUmbral,
    });
  }

  /**
   * Auditoría de seguridad. En `metadata` NUNCA van tokens ni contraseñas:
   * la tabla se consulta y se exporta, y lo que se guarda ahí se filtra con ella.
   */
  private async auditar(
    actorUserId: string | null,
    action: string,
    contexto: ContextoPeticion,
    metadata: Record<string, unknown> | null,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType: 'user',
        entityId: actorUserId,
        ipAddress: contexto.ip ?? null,
        userAgent: contexto.userAgent?.slice(0, 255) ?? null,
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private aUsuarioAutenticado(usuario: {
    id: string;
    email: string;
    fullName: string;
    status: string;
    lastLoginAt: Date | null;
    blockedAt: Date | null;
    blockedReason: string | null;
    createdAt: Date;
    roles: { role: { code: string } }[];
  }): UsuarioAutenticado {
    const roles = usuario.roles.map((r) => r.role.code);
    return {
      id: usuario.id,
      email: usuario.email,
      fullName: usuario.fullName,
      status: usuario.status,
      roles,
      permissions: permisosDe(roles),
      lastLoginAt: usuario.lastLoginAt?.toISOString() ?? null,
      blockedAt: usuario.blockedAt?.toISOString() ?? null,
      blockedReason: usuario.blockedReason,
      createdAt: usuario.createdAt.toISOString(),
    };
  }
}
