import { Permiso, permisosDe, tienePermiso, veTodosLosTickets } from './permissions.js';

describe('mapa rol → permisos', () => {
  it('el admin tiene todos los permisos', () => {
    expect(permisosDe(['admin']).sort()).toEqual(Object.values(Permiso).sort());
  });

  it('el supervisor ve todo, crea, asigna y comenta, pero no edita, no cambia estado ni bloquea', () => {
    const permisos = permisosDe(['supervisor']);
    expect(permisos).toEqual(
      expect.arrayContaining([
        Permiso.TICKET_LEER_TODOS,
        Permiso.TICKET_CREAR,
        Permiso.TICKET_ASIGNAR,
        Permiso.COMENTARIO_CREAR,
      ]),
    );
    expect(permisos).not.toContain(Permiso.TICKET_ACTUALIZAR);
    expect(permisos).not.toContain(Permiso.TICKET_CAMBIAR_ESTADO);
    expect(permisos).not.toContain(Permiso.USUARIO_BLOQUEAR);
  });

  it('el agente no ve todos los tickets, no asigna ni gestiona usuarios', () => {
    const permisos = permisosDe(['agent']);
    expect(permisos).not.toContain(Permiso.TICKET_LEER_TODOS);
    expect(permisos).not.toContain(Permiso.TICKET_ASIGNAR);
    expect(permisos).not.toContain(Permiso.USUARIO_LEER);
    expect(permisos).not.toContain(Permiso.USUARIO_BLOQUEAR);
    // Sí edita y cambia estado: la restricción a SUS tickets es de pertenencia
    // y se comprueba en el servicio, no aquí.
    expect(permisos).toEqual(
      expect.arrayContaining([Permiso.TICKET_ACTUALIZAR, Permiso.TICKET_CAMBIAR_ESTADO]),
    );
  });

  it('roles N:M: un usuario con varios roles recibe la unión, sin duplicados', () => {
    const permisos = permisosDe(['supervisor', 'agent']);
    expect(permisos).toContain(Permiso.TICKET_ASIGNAR); // del supervisor
    expect(permisos).toContain(Permiso.TICKET_CAMBIAR_ESTADO); // del agente
    expect(new Set(permisos).size).toBe(permisos.length);
  });

  it('un rol desconocido no concede nada', () => {
    expect(permisosDe(['root'])).toEqual([]);
    expect(tienePermiso(['root'], Permiso.TICKET_CREAR)).toBe(false);
  });

  it('veTodosLosTickets: admin y supervisor sí, agente no', () => {
    expect(veTodosLosTickets(['admin'])).toBe(true);
    expect(veTodosLosTickets(['supervisor'])).toBe(true);
    expect(veTodosLosTickets(['agent'])).toBe(false);
  });
});
