// Máquina de estados del ticket. Una transición fuera de esta tabla es un 409:
// la petición es válida, lo que no la admite es el estado actual del recurso.
import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import { Permiso, tienePermiso, veTodosLosTickets } from '../auth/permissions.js';
import type { TicketStatus } from '../generated/prisma/enums.js';

const TRANSICIONES: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['in_progress', 'pending_customer', 'resolved'],
  in_progress: ['open', 'pending_customer', 'resolved'],
  pending_customer: ['in_progress', 'resolved'],
  // resolved → in_progress: el cliente dice que no está resuelto. No es una
  // reapertura (el ticket no llegó a cerrarse), pero deshace la resolución.
  resolved: ['in_progress', 'closed'],
  // Reabrir no es un estado nuevo: devuelve el ticket a open.
  closed: ['open'],
};

export function esTransicionValida(desde: TicketStatus, hacia: TicketStatus): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

/** Cerrar y reabrir son decisiones de administrador. */
export function requiereAdmin(desde: TicketStatus, hacia: TicketStatus): boolean {
  return hacia === 'closed' || desde === 'closed';
}

export function esReapertura(desde: TicketStatus, hacia: TicketStatus): boolean {
  return desde === 'closed' && hacia === 'open';
}

/** Salir de resolved sin cerrar deshace la resolución. */
export function deshaceResolucion(desde: TicketStatus, hacia: TicketStatus): boolean {
  return (desde === 'resolved' && hacia !== 'closed') || esReapertura(desde, hacia);
}

/**
 * Estados a los que ESTE usuario puede mover ESTE ticket ahora: máquina de
 * estados ∩ rol ∩ pertenencia. Va en el detalle para que el cliente no duplique
 * la regla; si la duplicara, el día que cambie aquí el front seguiría
 * ofreciendo botones que el servidor rechaza.
 */
export function transicionesPermitidas(
  desde: TicketStatus,
  usuario: UsuarioPeticion,
  asignadoA: string | null,
): TicketStatus[] {
  if (!tienePermiso(usuario.roles, Permiso.TICKET_CAMBIAR_ESTADO)) return [];
  // Pertenencia: quien no ve todos los tickets solo mueve los suyos.
  if (!veTodosLosTickets(usuario.roles) && asignadoA !== usuario.id) return [];

  const esAdmin = usuario.roles.includes('admin');
  return TRANSICIONES[desde].filter((hacia) => esAdmin || !requiereAdmin(desde, hacia));
}
