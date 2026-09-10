// La validación falla con 422 y `errors` campo a campo, como fija el contrato.
// Nest devuelve 400 con un array de strings por defecto; eso obligaría al
// cliente a parsear texto para saber qué campo falló.
import { ValidationPipe, ValidationError } from '@nestjs/common';

import { AppError } from './app-error.js';
import { CodigoError, ErrorDeCampo } from './problem.js';

function aplanar(errores: ValidationError[], prefijo = ''): ErrorDeCampo[] {
  return errores.flatMap((error) => {
    const campo = prefijo === '' ? error.property : `${prefijo}.${error.property}`;
    const propios = Object.values(error.constraints ?? {}).map((message) => ({
      field: campo,
      message,
    }));
    const anidados = aplanar(error.children ?? [], campo);
    return [...propios, ...anidados];
  });
}

export function crearValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true, // descarta lo que no esté en el DTO
    forbidNonWhitelisted: true, // y avisa en vez de ignorarlo en silencio
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errores: ValidationError[]) =>
      new AppError(
        CodigoError.VALIDATION_ERROR,
        422,
        'Entrada inválida',
        'Uno o más campos no cumplen el formato esperado.',
        aplanar(errores),
      ),
  });
}
