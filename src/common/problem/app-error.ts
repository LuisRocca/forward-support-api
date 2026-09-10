// Excepción propia de la aplicación: lleva siempre un código estable, que es lo
// que el filtro global traduce a RFC 9457.
import { HttpException } from '@nestjs/common';

import { CodigoError, ErrorDeCampo } from './problem.js';

export class AppError extends HttpException {
  constructor(
    readonly codigo: CodigoError,
    status: number,
    readonly titulo: string,
    readonly detalle?: string,
    readonly errores?: ErrorDeCampo[],
  ) {
    super(titulo, status);
  }

  static credencialesInvalidas(): AppError {
    // Mismo mensaje exista o no el email: distinguirlos permite enumerar cuentas.
    return new AppError(
      CodigoError.AUTH_INVALID_CREDENTIALS,
      401,
      'Credenciales inválidas',
      'El email o la contraseña no son correctos.',
    );
  }

  static tokenExpirado(): AppError {
    return new AppError(
      CodigoError.AUTH_TOKEN_EXPIRED,
      401,
      'El token de acceso ha expirado',
      'Renueva la sesión con /auth/refresh y reintenta.',
    );
  }

  static tokenRevocado(detalle?: string): AppError {
    return new AppError(
      CodigoError.AUTH_TOKEN_REVOKED,
      401,
      'La sesión ha sido revocada',
      detalle ?? 'Vuelve a iniciar sesión.',
    );
  }

  static tokenInvalido(): AppError {
    return new AppError(
      CodigoError.AUTH_TOKEN_INVALID,
      401,
      'Falta el token de acceso o no es legible',
      'Vuelve a iniciar sesión.',
    );
  }

  static usuarioBloqueado(motivo?: string | null): AppError {
    return new AppError(
      CodigoError.AUTH_USER_BLOCKED,
      401,
      'La cuenta está bloqueada',
      motivo ?? 'Contacta con un administrador.',
    );
  }

  /** 423: la cuenta existe pero está cerrada, administrativamente o por intentos fallidos. */
  static cuentaBloqueada(detalle: string): AppError {
    return new AppError(CodigoError.ACCOUNT_LOCKED, 423, 'Cuenta bloqueada', detalle);
  }

  static prohibido(detalle?: string): AppError {
    return new AppError(CodigoError.FORBIDDEN, 403, 'Sin permiso sobre este recurso', detalle);
  }

  /**
   * 404 también cuando el recurso existe pero no es visible para quien pregunta:
   * un 403 distinguible confirma que existe y permite enumerar.
   */
  static noEncontrado(detalle?: string): AppError {
    return new AppError(CodigoError.NOT_FOUND, 404, 'Recurso no encontrado', detalle);
  }

  static conflicto(detalle: string, codigo: CodigoError = CodigoError.CONFLICT): AppError {
    return new AppError(codigo, 409, 'Conflicto con el estado actual del recurso', detalle);
  }
}
