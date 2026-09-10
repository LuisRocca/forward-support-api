import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Usuario ya verificado por el guard, adjunto a la petición. */
export interface UsuarioPeticion {
  id: string;
  roles: string[];
}

declare module 'express' {
  interface Request {
    usuario?: UsuarioPeticion;
  }
}

export const UsuarioActual = createParamDecorator(
  (_dato: unknown, contexto: ExecutionContext): UsuarioPeticion => {
    const peticion = contexto.switchToHttp().getRequest<Request>();
    if (peticion.usuario === undefined) {
      throw new Error('UsuarioActual usado en una ruta sin JwtAuthGuard');
    }
    return peticion.usuario;
  },
);
