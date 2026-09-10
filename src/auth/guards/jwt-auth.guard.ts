// Guard global. Niega por defecto: solo pasan sin token las rutas marcadas
// con @Publico().
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AppError } from '../../common/problem/app-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CLAVE_PUBLICO } from '../decorators/public.decorator.js';
import { TokenService } from '../token.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const esPublico = this.reflector.getAllAndOverride<boolean>(CLAVE_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (esPublico === true) return true;

    const peticion = contexto.switchToHttp().getRequest<Request>();
    const token = this.extraerToken(peticion);
    if (token === null) throw AppError.tokenInvalido();

    let claims;
    try {
      claims = await this.tokens.verificarAccessToken(token);
    } catch (error) {
      // Expirado y "roto" son cosas distintas para el cliente: con el primero
      // reintenta el refresh, con el segundo cierra sesión. Devolver el mismo
      // código para los dos provoca un bucle de refresh en el front.
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw AppError.tokenExpirado();
      }
      throw AppError.tokenInvalido();
    }

    // Comprobación contra Postgres, no solo contra el TTL del token. Es un
    // lookup por clave primaria sobre una tabla pequeña, y a cambio bloquear a
    // un usuario surte efecto de inmediato y es demostrable en vivo. Cuando el
    // volumen lo justifique, esta lectura se mueve a Redis sin tocar nada más.
    const usuario = await this.prisma.user.findFirst({
      where: { id: claims.sub, deletedAt: null },
      select: {
        id: true,
        status: true,
        tokenVersion: true,
        blockedReason: true,
        roles: { select: { role: { select: { code: true } } } },
      },
    });

    if (usuario === null) throw AppError.tokenRevocado('La cuenta ya no existe.');

    if (usuario.tokenVersion !== claims.tokenVersion) {
      throw AppError.tokenRevocado(
        'La sesión se invalidó por un cambio de contraseña o un bloqueo.',
      );
    }

    if (usuario.status !== 'active') {
      throw AppError.usuarioBloqueado(usuario.blockedReason);
    }

    // Los roles salen de la base, no del token: si a alguien le quitan un rol,
    // el cambio surte efecto sin esperar a que expire el JWT.
    peticion.usuario = { id: usuario.id, roles: usuario.roles.map((r) => r.role.code) };
    return true;
  }

  private extraerToken(peticion: Request): string | null {
    const cabecera = peticion.headers.authorization;
    if (typeof cabecera !== 'string') return null;
    const [esquema, valor] = cabecera.split(' ');
    if (esquema?.toLowerCase() !== 'bearer' || valor === undefined || valor === '') return null;
    return valor;
  }
}
