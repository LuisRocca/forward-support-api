import { Controller, Get } from '@nestjs/common';

import { RequierePermisos } from '../auth/decorators/permissions.decorator.js';
import { Permiso } from '../auth/permissions.js';
import { DashboardMetrics, MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('dashboard')
  @RequierePermisos(Permiso.METRICAS_LEER)
  async dashboard(): Promise<DashboardMetrics> {
    return this.metrics.dashboard();
  }
}
