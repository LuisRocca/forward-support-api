// Emisión y rotación de tokens.
//
// Dos tokens con propósitos distintos:
//   - Access: JWT de 15 min, firmado, sin estado salvo la comprobación de
//     tokenVersion. Viaja en la cabecera Authorization.
//   - Refresh: opaco (no es un JWT: no hace falta que el cliente lea nada de
//     él), 7 días, en cookie httpOnly. En la base se guarda su SHA-256.
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { EnvService } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ClaimsAccess {
  sub: string;
  /** Se compara contra users.token_version en cada request. */
  tokenVersion: number;
  roles: string[];
}

export interface TokenEmitido {
  token: string;
  expiraEn: number;
}

/** Datos de la petición que se guardan con la sesión, para auditoría. */
export interface ContextoPeticion {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
  ) {}

  async emitirAccessToken(claims: ClaimsAccess): Promise<TokenEmitido> {
    const expiraEn = this.env.accessTtlSegundos;
    const token = await this.jwt.signAsync(claims, {
      secret: this.env.jwtAccessSecret,
      expiresIn: expiraEn,
    });
    return { token, expiraEn };
  }

  /**
   * Lanza si el token es inválido. Distingue expirado de todo lo demás, porque
   * el cliente reintenta el refresh solo en el primer caso.
   */
  async verificarAccessToken(token: string): Promise<ClaimsAccess> {
    return this.jwt.verifyAsync<ClaimsAccess>(token, { secret: this.env.jwtAccessSecret });
  }

  /**
   * El token plano solo existe en memoria y en la cookie. En la base va su
   * SHA-256: si se filtra la base, esos hashes no sirven para entrar.
   *
   * SHA-256 sin sal es correcto aquí y no lo sería para una contraseña: el token
   * son 32 bytes aleatorios, no hay diccionario que atacar ni valor que repetir.
   */
  private hashDe(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Crea una sesión nueva (login). Abre familia propia. */
  async emitirRefreshToken(userId: string, contexto: ContextoPeticion): Promise<TokenEmitido> {
    return this.crearRefresh(userId, randomUUID(), contexto);
  }

  private async crearRefresh(
    userId: string,
    familyId: string,
    contexto: ContextoPeticion,
  ): Promise<TokenEmitido> {
    const token = randomBytes(32).toString('base64url');
    const expiraEn = this.env.refreshTtlSegundos;

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashDe(token),
        familyId,
        expiresAt: new Date(Date.now() + expiraEn * 1000),
        ipAddress: contexto.ip ?? null,
        userAgent: contexto.userAgent?.slice(0, 255) ?? null,
      },
    });

    return { token, expiraEn };
  }

  /**
   * Rota el refresh: invalida el usado y emite otro de la misma familia.
   *
   * Si llega un token que YA fue rotado, se asume robo —el legítimo y el ladrón
   * no pueden usar el mismo token dos veces— y se revoca la familia entera. El
   * usuario tendrá que volver a entrar, que es preferible a dejar viva una
   * sesión robada.
   *
   * Todo va en una transacción: revocar el viejo y crear el nuevo no pueden
   * quedar a medias, o se pierde la sesión o se dejan dos vivas.
   */
  async rotar(
    tokenPlano: string,
    contexto: ContextoPeticion,
  ): Promise<{ userId: string; refresh: TokenEmitido } | null> {
    const hash = this.hashDe(tokenPlano);
    const guardado = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });

    if (guardado === null) return null;

    if (guardado.revokedAt !== null) {
      await this.revocarFamilia(guardado.familyId, 'reuse_detected');
      return null;
    }

    if (guardado.expiresAt.getTime() <= Date.now()) return null;

    const token = randomBytes(32).toString('base64url');
    const expiraEn = this.env.refreshTtlSegundos;

    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: guardado.id },
        data: { revokedAt: new Date(), revokedReason: 'rotated' },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: guardado.userId,
          tokenHash: this.hashDe(token),
          familyId: guardado.familyId,
          expiresAt: new Date(Date.now() + expiraEn * 1000),
          ipAddress: contexto.ip ?? null,
          userAgent: contexto.userAgent?.slice(0, 255) ?? null,
        },
      }),
    ]);

    return { userId: guardado.userId, refresh: { token, expiraEn } };
  }

  async revocarPorToken(tokenPlano: string, motivo: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashDe(tokenPlano), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: motivo },
    });
  }

  async revocarFamilia(familyId: string, motivo: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: motivo },
    });
  }

  /** Al bloquear a un usuario: ninguna de sus sesiones puede renovarse. */
  async revocarTodasLasSesiones(userId: string, motivo: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: motivo },
    });
  }
}
