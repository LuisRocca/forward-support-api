import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';

import { AppError } from '../common/problem/app-error.js';
import { AuthService } from './auth.service.js';
import type { Sesion, UsuarioAutenticado } from './auth.service.js';
import { UsuarioActual } from './decorators/current-user.decorator.js';
import type { UsuarioPeticion } from './decorators/current-user.decorator.js';
import { Publico } from './decorators/public.decorator.js';
import { LoginDto } from './dto/login.dto.js';
import type { ContextoPeticion } from './token.service.js';

const COOKIE_REFRESH = 'refresh_token';

// Los límites se leen del entorno al cargar el módulo: @Throttle es un decorador
// y se evalúa antes de que exista inyección de dependencias.
//
// El de login es más estricto que el de refresh porque es el que se ataca por
// fuerza bruta. Es una defensa DISTINTA del bloqueo por intentos fallidos de la
// cuenta: este frena a una IP martilleando, y aquel frena un ataque repartido
// entre muchas IPs contra una misma cuenta. Por eso el límite por IP puede ser
// más bajo que el umbral de bloqueo de la cuenta sin dejarlo inalcanzable.
const LIMITE_LOGIN = Number(process.env['AUTH_RATE_LIMIT_LOGIN'] ?? 5);
const LIMITE_REFRESH = Number(process.env['AUTH_RATE_LIMIT_REFRESH'] ?? 30);
const VENTANA_MS = 60_000;

interface RespuestaSesion {
  accessToken: string;
  expiresIn: number;
  user: UsuarioAutenticado;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Publico()
  @Post('login')
  @HttpCode(200)
  // Límite estricto: el login es el endpoint que se ataca por fuerza bruta.
  @Throttle({ auth: { limit: LIMITE_LOGIN, ttl: VENTANA_MS } })
  async login(
    @Body() dto: LoginDto,
    @Req() peticion: Request,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<RespuestaSesion> {
    const sesion = await this.auth.login(dto.email, dto.password, this.contexto(peticion));
    return this.responder(sesion, respuesta);
  }

  @Publico()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ auth: { limit: LIMITE_REFRESH, ttl: VENTANA_MS } })
  async refresh(
    @Req() peticion: Request,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<RespuestaSesion> {
    const token = this.leerCookie(peticion);
    if (token === undefined) {
      throw AppError.tokenRevocado('No hay sesión que renovar.');
    }
    const sesion = await this.auth.refresh(token, this.contexto(peticion));
    return this.responder(sesion, respuesta);
  }

  @Publico()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() peticion: Request,
    @Res({ passthrough: true }) respuesta: Response,
  ): Promise<void> {
    await this.auth.logout(this.leerCookie(peticion));
    respuesta.clearCookie(COOKIE_REFRESH, this.opcionesCookie());
  }

  @Get('me')
  async yo(@UsuarioActual() usuario: UsuarioPeticion): Promise<UsuarioAutenticado> {
    return this.auth.usuarioAutenticado(usuario.id);
  }

  /**
   * El refresh token va SOLO en la cookie, nunca en el cuerpo: si viajara en el
   * JSON, cualquier XSS podría leerlo, que es justo lo que httpOnly evita.
   */
  private responder(sesion: Sesion, respuesta: Response): RespuestaSesion {
    respuesta.cookie(COOKIE_REFRESH, sesion.refreshToken, {
      ...this.opcionesCookie(),
      maxAge: sesion.refreshExpiresIn * 1000,
    });
    return {
      accessToken: sesion.accessToken,
      expiresIn: sesion.expiresIn,
      user: sesion.user,
    };
  }

  private opcionesCookie(): CookieOptions {
    return {
      httpOnly: true, // JavaScript no la ve: inmune a XSS
      // Siempre, también en desarrollo: los navegadores modernos tratan
      // localhost como contexto seguro y aceptan la cookie por http. Hacerla
      // condicional crearía una divergencia entre desarrollo y producción justo
      // en un atributo de seguridad, que es como se acaba desplegando sin él.
      secure: true,
      sameSite: 'strict', // no viaja en peticiones cross-site: defensa CSRF
      path: '/auth', // solo se envía a los endpoints que la necesitan
    };
  }

  private leerCookie(peticion: Request): string | undefined {
    const valor = (peticion.cookies as Record<string, unknown> | undefined)?.[COOKIE_REFRESH];
    return typeof valor === 'string' && valor !== '' ? valor : undefined;
  }

  private contexto(peticion: Request): ContextoPeticion {
    return { ip: peticion.ip ?? null, userAgent: peticion.headers['user-agent'] ?? null };
  }
}
