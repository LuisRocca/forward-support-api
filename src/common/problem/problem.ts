// RFC 9457 (application/problem+json). Un único formato de error para toda la
// API: el front tiene un solo camino de manejo.
//
// `code` es el identificador ESTABLE sobre el que ramifica el cliente. `title`
// es texto para humanos y puede cambiar sin romper a nadie.

/** Códigos que el cliente conoce. Cambiar uno es romper el contrato. */
export const CodigoError = {
  // 401 — los tres que el cliente distingue para decidir si reintenta
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_REVOKED: 'AUTH_TOKEN_REVOKED',
  AUTH_USER_BLOCKED: 'AUTH_USER_BLOCKED',
  // 401 — token ausente o ilegible. El cliente no lo distingue: cualquier
  // código que no sea AUTH_TOKEN_EXPIRED significa "no reintentes, ve al login".
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',

  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  // Tres 409 distintos porque el cliente reacciona distinto a cada uno:
  // transición fuera de la máquina (no reintentar), cambio concurrente
  // (CONFLICT: recargar) y ticket cerrado (solo el admin puede reabrir).
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  TICKET_CLOSED: 'TICKET_CLOSED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type CodigoError = (typeof CodigoError)[keyof typeof CodigoError];

export interface ErrorDeCampo {
  field: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: CodigoError;
  traceId?: string;
  errors?: ErrorDeCampo[];
}

const BASE_TIPO = 'https://docs.forward.local/errors/';

/** El `type` es un URI derivado del código, en kebab-case. */
export function tipoDesdeCodigo(codigo: CodigoError): string {
  return BASE_TIPO + codigo.toLowerCase().replaceAll('_', '-');
}
