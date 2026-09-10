import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service.js';
import type { TicketPriority, TicketStatus } from '../generated/prisma/enums.js';

export interface DashboardMetrics {
  generatedAt: string;
  openTickets: number;
  staleTickets: number;
  unassignedTickets: number;
  resolvedLast7Days: number;
  byStatus: { status: TicketStatus; count: number }[];
  byPriority: { priority: TicketPriority; count: number }[];
  avgResolutionHoursByPriority: { priority: TicketPriority; hours: number | null }[];
}

/** Forma cruda de la vista materializada: snake_case y bigint. */
interface FilaVista {
  generated_at: Date;
  open_tickets: bigint;
  stale_tickets: bigint;
  unassigned_tickets: bigint;
  resolved_last_7_days: bigint;
  by_status: { status: TicketStatus; count: number }[];
  by_priority: { priority: TicketPriority; count: number }[];
  avg_resolution_hours_by_priority: { priority: TicketPriority; hours: number | null }[];
}

@Injectable()
export class MetricsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Metrics');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lee la vista, no cuenta filas. Las cuatro cifras del dashboard son
   * agregaciones globales que tienen que leer la tabla entera: lo que las hace
   * viables no es un índice, es no ejecutarlas en cada carga.
   */
  async dashboard(): Promise<DashboardMetrics> {
    const [fila] = await this.prisma.$queryRaw<FilaVista[]>`
      SELECT generated_at, open_tickets, stale_tickets, unassigned_tickets,
             resolved_last_7_days, by_status, by_priority,
             avg_resolution_hours_by_priority
      FROM dashboard_metrics
    `;

    if (fila === undefined) {
      // La vista existe pero está vacía: solo puede pasar si alguien la truncó.
      throw new Error('La vista dashboard_metrics no tiene datos');
    }

    return {
      // Que el front lo muestre: los datos no son de tiempo real y aparentar
      // que lo son es peor que decir de cuándo son.
      generatedAt: fila.generated_at.toISOString(),
      openTickets: Number(fila.open_tickets),
      staleTickets: Number(fila.stale_tickets),
      unassignedTickets: Number(fila.unassigned_tickets),
      resolvedLast7Days: Number(fila.resolved_last_7_days),
      byStatus: fila.by_status,
      byPriority: fila.by_priority,
      avgResolutionHoursByPriority: fila.avg_resolution_hours_by_priority,
    };
  }

  /**
   * Refresco al arrancar: sin él, tras un despliegue o un reinicio el dashboard
   * serviría datos de hasta 5 minutos antes del arranque, o de la última vez que
   * alguien levantó la app. No se espera: el arranque no debe bloquearse por
   * una agregación sobre toda la tabla.
   */
  onApplicationBootstrap(): void {
    void this.refrescar();
  }

  /**
   * CONCURRENTLY: no bloquea las lecturas mientras se recalcula. Necesita el
   * índice único que crea la migración.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async refrescar(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_metrics');
    } catch (error) {
      // Que falle un refresco no puede tumbar la aplicación: el dashboard
      // seguirá sirviendo los datos anteriores, y generated_at lo delata.
      this.logger.error('No se pudo refrescar dashboard_metrics', error as Error);
    }
  }
}
