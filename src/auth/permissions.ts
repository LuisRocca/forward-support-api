// Mapa rol → permisos, versionado con la aplicación y no en base de datos.
// Hoy son estáticos, y en código son testeables y revisables en el PR.
// Cuando el negocio pida permisos configurables por UI aparece `role_permissions`.
//
// El front los usa para decidir qué pinta. Eso es SOLO experiencia de usuario:
// el servidor vuelve a verificar en cada endpoint. Ocultar un botón no es
// autorización.

export const Permiso = {
  TICKET_LEER_TODOS: 'ticket:read:all',
  TICKET_LEER_ASIGNADOS: 'ticket:read:own',
  TICKET_CREAR: 'ticket:create',
  TICKET_ACTUALIZAR: 'ticket:update',
  TICKET_ASIGNAR: 'ticket:assign',
  TICKET_CAMBIAR_ESTADO: 'ticket:status',
  COMENTARIO_CREAR: 'comment:create',
  COMENTARIO_LEER_INTERNOS: 'comment:read:internal',
  USUARIO_LEER: 'user:read',
  USUARIO_BLOQUEAR: 'user:block',
  CLIENTE_LEER: 'client:read',
  METRICAS_LEER: 'metrics:read',
} as const;

export type Permiso = (typeof Permiso)[keyof typeof Permiso];

export type CodigoRol = 'admin' | 'supervisor' | 'agent';

const PERMISOS_POR_ROL: Record<CodigoRol, readonly Permiso[]> = {
  admin: Object.values(Permiso),
  supervisor: [
    Permiso.TICKET_LEER_TODOS,
    Permiso.TICKET_CREAR,
    Permiso.TICKET_ACTUALIZAR,
    Permiso.TICKET_ASIGNAR,
    Permiso.TICKET_CAMBIAR_ESTADO,
    Permiso.COMENTARIO_CREAR,
    Permiso.COMENTARIO_LEER_INTERNOS,
    Permiso.USUARIO_LEER,
    Permiso.CLIENTE_LEER,
    Permiso.METRICAS_LEER,
  ],
  // El agente NO tiene TICKET_LEER_TODOS: solo ve los suyos. Y aunque tenga
  // TICKET_ACTUALIZAR, el endpoint comprueba además que el ticket sea suyo:
  // el permiso dice qué puede hacer, no sobre qué fila.
  agent: [
    Permiso.TICKET_LEER_ASIGNADOS,
    Permiso.TICKET_CREAR,
    Permiso.TICKET_ACTUALIZAR,
    Permiso.TICKET_CAMBIAR_ESTADO,
    Permiso.COMENTARIO_CREAR,
    Permiso.COMENTARIO_LEER_INTERNOS,
    Permiso.CLIENTE_LEER,
  ],
};

/** Unión de los permisos de todos los roles del usuario. */
export function permisosDe(roles: readonly string[]): Permiso[] {
  const efectivos = new Set<Permiso>();
  for (const rol of roles) {
    for (const permiso of PERMISOS_POR_ROL[rol as CodigoRol] ?? []) {
      efectivos.add(permiso);
    }
  }
  return [...efectivos];
}

export function tienePermiso(roles: readonly string[], permiso: Permiso): boolean {
  return permisosDe(roles).includes(permiso);
}

/** Admin y supervisor ven la operación completa; el agente solo su bandeja. */
export function veTodosLosTickets(roles: readonly string[]): boolean {
  return tienePermiso(roles, Permiso.TICKET_LEER_TODOS);
}
