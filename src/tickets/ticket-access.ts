// Carga un ticket SOLO si quien pregunta puede verlo. Toda operación sobre un
// ticket concreto pasa por aquí: es la comprobación de PERTENENCIA, la que
// evita que un agente con permiso de escritura toque tickets ajenos.
import { AppError } from '../common/problem/app-error.js';
import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import { veTodosLosTickets } from '../auth/permissions.js';
import type { TicketStatus } from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface TicketVisible {
  id: string;
  status: TicketStatus;
  assignedToUserId: string | null;
  createdByUserId: string;
}

export async function cargarTicketVisible(
  prisma: PrismaService,
  id: string,
  usuario: UsuarioPeticion,
): Promise<TicketVisible> {
  const ticket = await prisma.ticket.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, status: true, assignedToUserId: true, createdByUserId: true },
  });

  const visible =
    ticket !== null && (veTodosLosTickets(usuario.roles) || ticket.assignedToUserId === usuario.id);

  // 404 también si existe pero no es suyo: un 403 confirmaría que existe.
  if (!visible) throw AppError.noEncontrado('No existe un ticket con ese identificador.');
  return ticket;
}
