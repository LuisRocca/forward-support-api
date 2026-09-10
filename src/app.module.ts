import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './auth/guards/permissions.guard.js';
import { ConfigModule } from './config/config.module.js';
import { ProblemFilter } from './common/problem/problem.filter.js';
import { RetryAfterThrottlerGuard } from './common/throttler/retry-after.guard.js';
import { TraceMiddleware } from './common/trace/trace.middleware.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { TicketsModule } from './tickets/tickets.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // Límite general de la API; los endpoints de /auth llevan el suyo, más
    // estricto, con @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'auth', ttl: 60_000, limit: 120 }],
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    TicketsModule,
    CatalogModule,
    MetricsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    // El orden importa: primero se limita el tráfico, después se autentica y
    // por último se comprueban permisos.
    { provide: APP_GUARD, useClass: RetryAfterThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
