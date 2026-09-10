// Matriz de roles del enunciado, contra la aplicación real y la base de test.
//
// Por cada rol, lo que puede y lo que no, en tickets y usuarios. Los 403 son de
// ROL (el permiso no existe) y los 404 de PERTENENCIA (el ticket existe pero no
// es suyo, y decir 403 confirmaría que existe).
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import argon2 from 'argon2';
import cookieParser from 'cookie-parser';

import { AppModule } from './../src/app.module.js';
import { crearValidationPipe } from './../src/common/problem/validation.pipe.js';
import type { TicketStatus } from './../src/generated/prisma/enums.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const PASSWORD = 'Password.e2e.2026';
const EMAILS = {
  admin: 'matriz.admin@forward.test',
  supervisor: 'matriz.supervisor@forward.test',
  agente: 'matriz.agente@forward.test',
  otroAgente: 'matriz.otro@forward.test',
} as const;
type Rol = 'admin' | 'supervisor' | 'agente';

describe('Matriz de roles (e2e)', () => {
  let app: INestApplication<Server>;
  let prisma: PrismaService;
  let clientId: string;
  const ids = {} as Record<keyof typeof EMAILS, string>;
  const tokens = {} as Record<Rol, string>;

  const http = () => request(app.getHttpServer());
  const como = (rol: Rol) => ({ Authorization: `Bearer ${tokens[rol]}` });

  /** Ticket nuevo por caso: las escrituras de un test no contaminan a otro. */
  async function ticket(asignadoA: string | null, status: TicketStatus = 'open'): Promise<string> {
    const creado = await prisma.ticket.create({
      data: {
        clientId,
        title: 'Ticket de la matriz',
        description: 'Ticket para la matriz de roles',
        status,
        createdByUserId: ids.admin,
        assignedToUserId: asignadoA,
      },
    });
    return creado.id;
  }

  beforeAll(async () => {
    process.env['DATABASE_URL'] = process.env['DATABASE_URL_TEST'] ?? process.env['DATABASE_URL'];
    const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = modulo.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(crearValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const rolDe: Record<keyof typeof EMAILS, string> = {
      admin: 'admin',
      supervisor: 'supervisor',
      agente: 'agent',
      otroAgente: 'agent',
    };
    for (const [clave, email] of Object.entries(EMAILS) as [keyof typeof EMAILS, string][]) {
      const rol = await prisma.role.upsert({
        where: { code: rolDe[clave] },
        update: {},
        create: { code: rolDe[clave], name: rolDe[clave] },
      });
      const usuario = await prisma.user.upsert({
        where: { email },
        update: { passwordHash, status: 'active', failedLoginAttempts: 0, lockedUntil: null },
        create: { email, passwordHash, fullName: clave, roles: { create: { roleId: rol.id } } },
      });
      ids[clave] = usuario.id;
    }
    clientId = (await prisma.client.create({ data: { name: 'Cliente de la matriz' } })).id;

    // Un login por rol para toda la suite: /auth/login admite 5 por minuto.
    for (const rol of ['admin', 'supervisor', 'agente'] as const) {
      const respuesta = await http().post('/auth/login').send({ email: EMAILS[rol], password: PASSWORD });
      tokens[rol] = respuesta.body.accessToken as string;
    }
  });

  afterAll(async () => {
    const usuarios = Object.values(ids);
    // Primero los tickets: su historial referencia a los usuarios con RESTRICT.
    await prisma.ticket.deleteMany({ where: { clientId } });
    await prisma.client.delete({ where: { id: clientId } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorUserId: { in: usuarios } }, { entityId: { in: usuarios } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: usuarios } } });
    await app.close();
  });

  describe('ver', () => {
    it('el agente solo lista sus tickets; admin y supervisor ven también los ajenos', async () => {
      const suyo = await ticket(ids.agente);
      const ajeno = await ticket(ids.otroAgente);

      const delAgente = await http().get('/tickets?limit=100').set(como('agente')).expect(200);
      const idsAgente = (delAgente.body.data as { id: string }[]).map((t) => t.id);
      expect(idsAgente).toContain(suyo);
      expect(idsAgente).not.toContain(ajeno);

      for (const rol of ['admin', 'supervisor'] as const) {
        const respuesta = await http().get('/tickets?limit=100').set(como(rol)).expect(200);
        expect((respuesta.body.data as { id: string }[]).map((t) => t.id)).toContain(ajeno);
      }
    });

    it('detalle de un ticket ajeno: agente 404, admin y supervisor 200', async () => {
      const ajeno = await ticket(ids.otroAgente);
      await http().get(`/tickets/${ajeno}`).set(como('agente')).expect(404);
      await http().get(`/tickets/${ajeno}`).set(como('supervisor')).expect(200);
      await http().get(`/tickets/${ajeno}`).set(como('admin')).expect(200);
    });
  });

  describe('crear', () => {
    const cuerpo = () => ({ clientId, title: 'Alta desde la matriz', description: 'Descripción del alta' });

    it.each(['admin', 'supervisor', 'agente'] as const)('%s puede crear', async (rol) => {
      await http().post('/tickets').set(como(rol)).send(cuerpo()).expect(201);
    });

    it('el agente queda autoasignado y no puede asignar a otro al crear', async () => {
      const creado = await http().post('/tickets').set(como('agente')).send(cuerpo()).expect(201);
      expect(creado.body.assignedTo.id).toBe(ids.agente);

      await http()
        .post('/tickets')
        .set(como('agente'))
        .send({ ...cuerpo(), assignedToUserId: ids.otroAgente })
        .expect(403);
    });
  });

  describe('editar', () => {
    const cambio = { priority: 'high' };

    it('admin edita cualquiera', async () => {
      await http().patch(`/tickets/${await ticket(ids.otroAgente)}`).set(como('admin')).send(cambio).expect(200);
    });
    it('supervisor no edita: 403', async () => {
      await http().patch(`/tickets/${await ticket(ids.otroAgente)}`).set(como('supervisor')).send(cambio).expect(403);
    });
    it('agente edita el suyo', async () => {
      await http().patch(`/tickets/${await ticket(ids.agente)}`).set(como('agente')).send(cambio).expect(200);
    });
    it('agente, ticket ajeno: 404', async () => {
      await http().patch(`/tickets/${await ticket(ids.otroAgente)}`).set(como('agente')).send(cambio).expect(404);
    });
  });

  describe('cambiar estado', () => {
    const aEnCurso = { status: 'in_progress' };

    it('admin cambia cualquiera, y es el único que cierra', async () => {
      await http().post(`/tickets/${await ticket(ids.otroAgente)}/status`).set(como('admin')).send(aEnCurso).expect(200);
      await http()
        .post(`/tickets/${await ticket(ids.otroAgente, 'resolved')}/status`)
        .set(como('admin'))
        .send({ status: 'closed' })
        .expect(200);
    });
    it('supervisor no cambia estados: 403 y allowedStatusTransitions vacío', async () => {
      const id = await ticket(ids.otroAgente);
      await http().post(`/tickets/${id}/status`).set(como('supervisor')).send(aEnCurso).expect(403);
      const detalle = await http().get(`/tickets/${id}`).set(como('supervisor')).expect(200);
      expect(detalle.body.allowedStatusTransitions).toEqual([]);
    });
    it('agente cambia el suyo, pero no lo cierra (403)', async () => {
      await http().post(`/tickets/${await ticket(ids.agente)}/status`).set(como('agente')).send(aEnCurso).expect(200);
      await http()
        .post(`/tickets/${await ticket(ids.agente, 'resolved')}/status`)
        .set(como('agente'))
        .send({ status: 'closed' })
        .expect(403);
    });
    it('agente, ticket ajeno: 404', async () => {
      await http().post(`/tickets/${await ticket(ids.otroAgente)}/status`).set(como('agente')).send(aEnCurso).expect(404);
    });
  });

  describe('asignar', () => {
    it('admin asigna un ticket de la bandeja', async () => {
      await http()
        .post(`/tickets/${await ticket(null)}/assign`)
        .set(como('admin'))
        .send({ assignedToUserId: ids.agente })
        .expect(200);
    });
    it('supervisor reasigna', async () => {
      const respuesta = await http()
        .post(`/tickets/${await ticket(ids.agente)}/assign`)
        .set(como('supervisor'))
        .send({ assignedToUserId: ids.otroAgente })
        .expect(200);
      expect(respuesta.body.reassignmentCount).toBe(1);
    });
    it('agente no asigna: 403', async () => {
      await http()
        .post(`/tickets/${await ticket(ids.agente)}/assign`)
        .set(como('agente'))
        .send({ assignedToUserId: ids.otroAgente })
        .expect(403);
    });
  });

  describe('comentar', () => {
    it.each(['admin', 'supervisor'] as const)('%s añade comentarios internos', async (rol) => {
      await http()
        .post(`/tickets/${await ticket(ids.agente)}/comments`)
        .set(como(rol))
        .send({ body: 'Nota interna', isInternal: true })
        .expect(201);
    });
    it('agente: comentario normal en el suyo sí, interno no (403)', async () => {
      const id = await ticket(ids.agente);
      await http().post(`/tickets/${id}/comments`).set(como('agente')).send({ body: 'Seguimiento' }).expect(201);
      await http()
        .post(`/tickets/${id}/comments`)
        .set(como('agente'))
        .send({ body: 'Interno', isInternal: true })
        .expect(403);
    });
    it('agente, ticket ajeno: 404', async () => {
      await http()
        .post(`/tickets/${await ticket(ids.otroAgente)}/comments`)
        .set(como('agente'))
        .send({ body: 'Hola' })
        .expect(404);
    });
  });

  describe('usuarios', () => {
    it('listar: admin y supervisor sí, agente 403', async () => {
      await http().get('/users').set(como('admin')).expect(200);
      await http().get('/users').set(como('supervisor')).expect(200);
      await http().get('/users').set(como('agente')).expect(403);
    });
    it('bloquear: solo admin; supervisor y agente 403', async () => {
      const cuerpo = { reason: 'Prueba de la matriz' };
      await http().post(`/users/${ids.otroAgente}/block`).set(como('supervisor')).send(cuerpo).expect(403);
      await http().post(`/users/${ids.otroAgente}/block`).set(como('agente')).send(cuerpo).expect(403);
      await http().post(`/users/${ids.otroAgente}/block`).set(como('admin')).send(cuerpo).expect(200);
      await http().post(`/users/${ids.otroAgente}/unblock`).set(como('admin')).expect(200);
    });
  });
});
