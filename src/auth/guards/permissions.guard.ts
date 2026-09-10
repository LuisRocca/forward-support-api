import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AppError } from '../../common/problem/app-error.js';
import { CLAVE_PERMISOS } from '../decorators/permissions.decorator.js';
import { Permiso, tienePermiso } from '../permissions.js';

/**
 * Comprueba permisos por ROL. No comprueba pertenencia: que un agente pueda
 * actualizar tickets no significa que pueda actualizar ESTE ticket. Esa segunda
 * comprobación va en el servicio, contra la fila concreta.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const requeridos = this.reflector.getAllAndOverride<Permiso[]>(CLAVE_PERMISOS, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (requeridos === undefined || requeridos.length === 0) return true;

    const peticion = contexto.switchToHttp().getRequest<Request>();
    const roles = peticion.usuario?.roles ?? [];

    const permitido = requeridos.every((permiso) => tienePermiso(roles, permiso));
    if (!permitido) throw AppError.prohibido('Tu rol no permite esta acción.');
    return true;
  }
}
