// El 429 tiene que llevar Retry-After en segundos. Sin ese dato el cliente solo
// puede inventarse una espera o reintentar a ciegas, que es exactamente lo que
// agrava un rate limit.
//
// Y no basta con mandarla: Retry-After no está entre las siete cabeceras que
// CORS expone por defecto, así que el navegador se la oculta al JavaScript del
// cliente y `headers.get('Retry-After')` devuelve null sin ningún error. Se
// expone en la configuración de CORS de main.ts.
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';

@Injectable()
export class RetryAfterThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    contexto: ExecutionContext,
    detalle: ThrottlerLimitDetail,
  ): Promise<void> {
    const respuesta = contexto.switchToHttp().getResponse<Response>();

    // La librería emite `Retry-After-<nombre del throttler>`, que ni es estándar
    // ni está expuesta por CORS: solo filtra cómo se llama la configuración
    // interna. Se quita y se deja la cabecera estándar.
    for (const cabecera of Object.keys(respuesta.getHeaders())) {
      if (cabecera.toLowerCase().startsWith('retry-after-')) {
        respuesta.removeHeader(cabecera);
      }
    }

    // timeToBlockExpire viene en segundos; nunca menos de 1, porque un
    // Retry-After de 0 invita a reintentar de inmediato.
    respuesta.header('Retry-After', String(Math.max(1, Math.ceil(detalle.timeToBlockExpire))));
    return super.throwThrottlingException(contexto, detalle);
  }
}
