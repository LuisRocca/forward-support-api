import { SetMetadata } from '@nestjs/common';

import { Permiso } from '../permissions.js';

export const CLAVE_PERMISOS = 'auth:permisos';

export const RequierePermisos = (...permisos: Permiso[]): MethodDecorator & ClassDecorator =>
  SetMetadata(CLAVE_PERMISOS, permisos);
