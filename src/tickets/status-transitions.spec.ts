import type { UsuarioPeticion } from '../auth/decorators/current-user.decorator.js';
import type { TicketStatus } from '../generated/prisma/enums.js';
import {
  deshaceResolucion,
  esReapertura,
  esTransicionValida,
  requiereAdmin,
  transicionesPermitidas,
} from './status-transitions.js';

const ESTADOS: TicketStatus[] = ['open', 'in_progress', 'pending_customer', 'resolved', 'closed'];

// La tabla del contrato, copiada A PROPÓSITO en vez de importada: si alguien
// cambia la máquina de estados sin cambiar el contrato, este test lo delata.
const CONTRATO: Record<TicketStatus, TicketStatus[]> = {
  open: ['in_progress', 'pending_customer', 'resolved'],
  in_progress: ['open', 'pending_customer', 'resolved'],
  pending_customer: ['in_progress', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: ['open'],
};

const admin: UsuarioPeticion = { id: 'admin', roles: ['admin'] };
const supervisor: UsuarioPeticion = { id: 'sup', roles: ['supervisor'] };
const agente: UsuarioPeticion = { id: 'agente', roles: ['agent'] };

describe('máquina de estados', () => {
  it.each(ESTADOS.flatMap((desde) => ESTADOS.map((hacia) => [desde, hacia] as const)))(
    '%s → %s coincide con la tabla del contrato',
    (desde, hacia) => {
      expect(esTransicionValida(desde, hacia)).toBe(CONTRATO[desde].includes(hacia));
    },
  );

  it('ningún estado transiciona a sí mismo', () => {
    for (const estado of ESTADOS) expect(esTransicionValida(estado, estado)).toBe(false);
  });

  it('cerrar y reabrir requieren admin; el resto no', () => {
    expect(requiereAdmin('resolved', 'closed')).toBe(true);
    expect(requiereAdmin('closed', 'open')).toBe(true);
    expect(requiereAdmin('open', 'resolved')).toBe(false);
    expect(requiereAdmin('resolved', 'in_progress')).toBe(false);
  });

  it('solo closed → open es reapertura; resolved → in_progress no cuenta', () => {
    expect(esReapertura('closed', 'open')).toBe(true);
    expect(esReapertura('resolved', 'in_progress')).toBe(false);
  });

  it('deshacen la resolución la reapertura y salir de resolved sin cerrar', () => {
    expect(deshaceResolucion('closed', 'open')).toBe(true);
    expect(deshaceResolucion('resolved', 'in_progress')).toBe(true);
    expect(deshaceResolucion('resolved', 'closed')).toBe(false);
    expect(deshaceResolucion('open', 'resolved')).toBe(false);
  });
});

describe('transicionesPermitidas: matriz ∩ rol ∩ pertenencia', () => {
  it('el admin recibe la matriz completa desde cualquier estado', () => {
    for (const estado of ESTADOS) {
      expect(transicionesPermitidas(estado, admin, 'otro')).toEqual(CONTRATO[estado]);
    }
  });

  it('el agente, sobre SU ticket, recibe la matriz sin cerrar ni reabrir', () => {
    expect(transicionesPermitidas('open', agente, 'agente')).toEqual(CONTRATO.open);
    expect(transicionesPermitidas('resolved', agente, 'agente')).toEqual(['in_progress']);
    expect(transicionesPermitidas('closed', agente, 'agente')).toEqual([]);
  });

  it('el agente, sobre un ticket AJENO o sin asignar, no recibe nada', () => {
    for (const estado of ESTADOS) {
      expect(transicionesPermitidas(estado, agente, 'otro')).toEqual([]);
      expect(transicionesPermitidas(estado, agente, null)).toEqual([]);
    }
  });

  it('el supervisor no cambia estados: siempre vacío', () => {
    for (const estado of ESTADOS) {
      expect(transicionesPermitidas(estado, supervisor, 'sup')).toEqual([]);
    }
  });
});
