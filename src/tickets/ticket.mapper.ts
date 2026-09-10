// Traducción de fila a forma de API. Vive aparte para que el servicio no mezcle
// la consulta con la serialización, y para que TicketSummary y TicketDetail no
// se solapen por accidente: el listado NO devuelve `description`.
import type { TicketPriority, TicketStatus } from '../generated/prisma/enums.js';

export interface UserRef {
  id: string;
  fullName: string;
}

export interface ClienteApi {
  id: string;
  name: string;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
}

export interface CategoriaApi {
  id: string;
  code: string;
  name: string;
  defaultPriority: TicketPriority | null;
  isActive: boolean;
}

export interface TicketSummary {
  id: string;
  code: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  client: ClienteApi;
  category: CategoriaApi | null;
  assignedTo: UserRef | null;
  createdAt: string;
  lastActivityAt: string;
}

export interface TicketDetail extends TicketSummary {
  description: string;
  commentCount: number;
  createdBy: UserRef;
  resolvedBy: UserRef | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  dueAt: string | null;
  reopenedCount: number;
  reassignmentCount: number;
  updatedAt: string;
}

/** Campos mínimos del listado. `description` queda deliberadamente fuera. */
export const SELECT_SUMMARY = {
  id: true,
  code: true,
  title: true,
  status: true,
  priority: true,
  createdAt: true,
  lastActivityAt: true,
  client: {
    select: {
      id: true,
      name: true,
      taxId: true,
      email: true,
      phone: true,
      isActive: true,
    },
  },
  category: {
    select: { id: true, code: true, name: true, defaultPriority: true, isActive: true },
  },
  assignedTo: { select: { id: true, fullName: true } },
} as const;

export const SELECT_DETAIL = {
  ...SELECT_SUMMARY,
  description: true,
  firstResponseAt: true,
  resolvedAt: true,
  closedAt: true,
  dueAt: true,
  reopenedCount: true,
  reassignmentCount: true,
  updatedAt: true,
  createdBy: { select: { id: true, fullName: true } },
  resolvedBy: { select: { id: true, fullName: true } },
} as const;

type FilaSummary = {
  id: string;
  code: string;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: Date;
  lastActivityAt: Date;
  client: ClienteApi;
  category: CategoriaApi | null;
  assignedTo: UserRef | null;
};

export function aSummary(fila: FilaSummary): TicketSummary {
  return {
    id: fila.id,
    code: fila.code,
    title: fila.title,
    status: fila.status,
    priority: fila.priority,
    client: fila.client,
    category: fila.category,
    assignedTo: fila.assignedTo,
    createdAt: fila.createdAt.toISOString(),
    lastActivityAt: fila.lastActivityAt.toISOString(),
  };
}

type FilaDetail = FilaSummary & {
  description: string;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  dueAt: Date | null;
  reopenedCount: number;
  reassignmentCount: number;
  updatedAt: Date;
  createdBy: UserRef;
  resolvedBy: UserRef | null;
};

export function aDetail(fila: FilaDetail, commentCount: number): TicketDetail {
  return {
    ...aSummary(fila),
    description: fila.description,
    commentCount,
    createdBy: fila.createdBy,
    resolvedBy: fila.resolvedBy,
    firstResponseAt: fila.firstResponseAt?.toISOString() ?? null,
    resolvedAt: fila.resolvedAt?.toISOString() ?? null,
    closedAt: fila.closedAt?.toISOString() ?? null,
    dueAt: fila.dueAt?.toISOString() ?? null,
    reopenedCount: fila.reopenedCount,
    reassignmentCount: fila.reassignmentCount,
    updatedAt: fila.updatedAt.toISOString(),
  };
}
