// Healthcheck del balanceador (ALB) y de ECS. Público, sin rate limiting y con
// un tiempo máximo propio.
//
// Sin rate limiting porque un 429 aquí haría que el balanceador diera la
// instancia por caída. Con timeout porque si la base se cuelga la comprobación
// tiene que fallar rápido: el ALB tiene su propio timeout y un healthcheck que
// no contesta es peor que uno que dice 503.
import { Controller, Get, HttpCode } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Publico } from '../auth/decorators/public.decorator.js';
import { AppError } from '../common/problem/app-error.js';
import { CodigoError } from '../common/problem/problem.js';
import { PrismaService } from '../prisma/prisma.service.js';

const TIMEOUT_MS = 2000;

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Publico()
  @SkipThrottle()
  @HttpCode(200)
  async comprobar(): Promise<{ status: 'ok'; database: 'up' }> {
    const disponible = await Promise.race([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      new Promise<boolean>((resolver) => setTimeout(() => resolver(false), TIMEOUT_MS)),
    ]);

    if (!disponible) {
      // Sin el error de la base en la respuesta: el endpoint es público y ese
      // detalle (host, usuario, versión) es información interna.
      throw new AppError(
        CodigoError.SERVICE_UNAVAILABLE,
        503,
        'Servicio no disponible',
        'La base de datos no responde.',
      );
    }
    return { status: 'ok', database: 'up' };
  }
}
