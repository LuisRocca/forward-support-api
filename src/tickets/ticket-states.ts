import type { TicketStatus } from '../generated/prisma/enums.js';

/**
 * Definición única de ticket "abierto" del contrato. Un resuelto espera cierre
 * y no requiere acción de ningún agente. Todo lo que el producto llama abierto,
 * estancado o sin asignar parte de este conjunto; la vista dashboard_metrics
 * usa exactamente el mismo.
 */
export const ESTADOS_ABIERTOS: readonly TicketStatus[] = ['open', 'in_progress', 'pending_customer'];
