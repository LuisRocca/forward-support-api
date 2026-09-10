import { SetMetadata } from '@nestjs/common';

export const CLAVE_PUBLICO = 'auth:publico';

/**
 * Marca un endpoint como accesible sin token. El guard es global y niega por
 * defecto: hay que optar por salir, no por entrar. Al revés, cualquier endpoint
 * nuevo nacería desprotegido y nadie se daría cuenta.
 */
export const Publico = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CLAVE_PUBLICO, true);
