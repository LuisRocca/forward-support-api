// Filtro global: TODA respuesta de error sale en RFC 9457, incluidos los 500 y
// las excepciones que no previmos. Que un 500 salga con otra forma obliga al
// cliente a tener dos caminos de manejo de errores, y el segundo nunca se prueba.
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { AppError } from './app-error.js';
import { CodigoError, Problem, tipoDesdeCodigo } from './problem.js';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(excepcion: unknown, host: ArgumentsHost): void {
    const contexto = host.switchToHttp();
    const respuesta = contexto.getResponse<Response>();
    const peticion = contexto.getRequest<Request>();

    const problem = this.aProblem(excepcion, peticion);

    // Solo lo inesperado se registra con traza completa. El traceId del log es
    // el mismo que recibe el cliente.
    if (problem.status >= 500) {
      this.logger.error(
        `[${problem.traceId ?? '-'}] ${peticion.method} ${peticion.url}`,
        excepcion instanceof Error ? excepcion.stack : String(excepcion),
      );
    }

    respuesta
      .status(problem.status)
      .type('application/problem+json')
      .json(problem);
  }

  private aProblem(excepcion: unknown, peticion: Request): Problem {
    const base = { instance: peticion.url, traceId: peticion.traceId };

    if (excepcion instanceof AppError) {
      return {
        type: tipoDesdeCodigo(excepcion.codigo),
        title: excepcion.titulo,
        status: excepcion.getStatus(),
        detail: excepcion.detalle,
        code: excepcion.codigo,
        ...(excepcion.errores !== undefined ? { errors: excepcion.errores } : {}),
        ...base,
      };
    }

    if (excepcion instanceof ThrottlerException) {
      return {
        type: tipoDesdeCodigo(CodigoError.RATE_LIMITED),
        title: 'Demasiadas peticiones',
        status: HttpStatus.TOO_MANY_REQUESTS,
        detail: 'Has superado el límite de intentos. Espera antes de reintentar.',
        code: CodigoError.RATE_LIMITED,
        ...base,
      };
    }

    if (excepcion instanceof HttpException) {
      const status = excepcion.getStatus();
      return {
        type: tipoDesdeCodigo(this.codigoPorStatus(status)),
        title: this.tituloPorStatus(status),
        status,
        detail: this.detalleDeHttpException(excepcion),
        code: this.codigoPorStatus(status),
        ...base,
      };
    }

    // Cualquier cosa no prevista. El detalle real va al log, no a la respuesta:
    // un stack trace en el cuerpo es una filtración de información interna.
    return {
      type: tipoDesdeCodigo(CodigoError.INTERNAL_ERROR),
      title: 'Error interno del servidor',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'Ha ocurrido un error inesperado. Usa el traceId para reportarlo.',
      code: CodigoError.INTERNAL_ERROR,
      ...base,
    };
  }

  private detalleDeHttpException(excepcion: HttpException): string | undefined {
    const cuerpo = excepcion.getResponse();
    if (typeof cuerpo === 'string') return cuerpo;
    if (typeof cuerpo === 'object' && cuerpo !== null && 'message' in cuerpo) {
      const mensaje = (cuerpo as { message: unknown }).message;
      if (typeof mensaje === 'string') return mensaje;
      if (Array.isArray(mensaje)) return mensaje.join('. ');
    }
    return undefined;
  }

  private codigoPorStatus(status: number): CodigoError {
    if (status === 401) return CodigoError.AUTH_TOKEN_INVALID;
    if (status === 403) return CodigoError.FORBIDDEN;
    if (status === 404) return CodigoError.NOT_FOUND;
    if (status === 409) return CodigoError.CONFLICT;
    if (status === 422) return CodigoError.VALIDATION_ERROR;
    if (status === 429) return CodigoError.RATE_LIMITED;
    return CodigoError.INTERNAL_ERROR;
  }

  private tituloPorStatus(status: number): string {
    const titulos: Record<number, string> = {
      400: 'Petición inválida',
      401: 'No autenticado',
      403: 'Sin permiso sobre este recurso',
      404: 'Recurso no encontrado',
      405: 'Método no permitido',
      409: 'Conflicto con el estado actual del recurso',
      422: 'Entrada inválida',
      429: 'Demasiadas peticiones',
    };
    return titulos[status] ?? 'Error interno del servidor';
  }
}
