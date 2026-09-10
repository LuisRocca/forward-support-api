// El supervisor no edita tickets ni cambia su estado: PATCH /tickets/{id} y
// POST /tickets/{id}/status son del admin y del agente sobre los suyos. Cada 403
// se contrasta con el admin sobre el MISMO id inexistente: si el admin recibe
// 404 y el supervisor 403, el 403 sale del rol y no de que el ticket no exista.
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import argon2 from 'argon2';
import cookieParser from 'cookie-parser';

import { AppModule } from './../src/app.module.js';
import { crearValidationPipe } from './../src/common/problem/validation.pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const PASSWORD = 'Password.e2e.2026';
const EMAILS = { admin: 'admin.e2e@forward.test', supervisor: 'supervisor.e2e@forward.test' };
const TICKET_INEXISTENTE = '01900000-0000-7000-8000-000000000000';

describe('Permisos sobre tickets (e2e)', () => {
  let app: INestApplication<Server>;
  let prisma: PrismaService;
  let ticketId: string;
  let clientId: string;
  // Un login por rol para toda la suite: /auth/login está limitado a 5 por
  // minuto y por IP, y un login por caso agota el límite a mitad de fichero.
  const tokens: Record<keyof typeof EMAILS, string> = { admin: '', supervisor: '' };

  async function login(email: string): Promise<string> {
    const respuesta = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return respuesta.body.accessToken as string;
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
    for (const [codigo, email] of Object.entries(EMAILS)) {
      const rol = await prisma.role.upsert({
        where: { code: codigo },
        update: {},
        create: { code: codigo, name: codigo },
      });
      await prisma.user.upsert({
        where: { email },
        update: { passwordHash, status: 'active', failedLoginAttempts: 0, lockedUntil: null },
        create: {
          email,
          passwordHash,
          fullName: `${codigo} e2e`,
          roles: { create: { roleId: rol.id } },
        },
      });
    }

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.admin } });
    const cliente = await prisma.client.create({ data: { name: 'Cliente e2e' } });
    clientId = cliente.id;
    const ticket = await prisma.ticket.create({
      data: {
        clientId,
        title: 'Ticket e2e',
        description: 'Ticket para probar permisos',
        createdByUserId: admin.id,
      },
    });
    ticketId = ticket.id;

    tokens.admin = await login(EMAILS.admin);
    tokens.supervisor = await login(EMAILS.supervisor);
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { clientId } });
    await prisma.client.delete({ where: { id: clientId } });
    const usuarios = { email: { in: Object.values(EMAILS) } };
    await prisma.auditLog.deleteMany({ where: { actor: usuarios } });
    await prisma.user.deleteMany({ where: usuarios });
    await app.close();
  });

  it('el supervisor recibe 403 al editar un ticket', async () => {
    const token = tokens.supervisor;
    const respuesta = await request(app.getHttpServer())
      .patch(`/tickets/${TICKET_INEXISTENTE}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priority: 'high' })
      .expect(403);

    expect(respuesta.body.code).toBe('FORBIDDEN');
  });

  it('el admin, con el mismo id, pasa el permiso y llega al 404', async () => {
    const token = tokens.admin;
    const respuesta = await request(app.getHttpServer())
      .patch(`/tickets/${TICKET_INEXISTENTE}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priority: 'high' })
      .expect(404);

    expect(respuesta.body.code).toBe('NOT_FOUND');
  });

  it('el supervisor recibe 403 al cambiar el estado', async () => {
    const token = tokens.supervisor;
    const respuesta = await request(app.getHttpServer())
      .post(`/tickets/${TICKET_INEXISTENTE}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'in_progress' })
      .expect(403);

    expect(respuesta.body.code).toBe('FORBIDDEN');
  });

  it('el admin, con el mismo id, pasa el permiso y llega al 404', async () => {
    const token = tokens.admin;
    await request(app.getHttpServer())
      .post(`/tickets/${TICKET_INEXISTENTE}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'in_progress' })
      .expect(404);
  });

  it('allowedStatusTransitions: vacío para el supervisor, la matriz completa para el admin', async () => {
    const supervisor = await request(app.getHttpServer())
      .get(`/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${tokens.supervisor}`)
      .expect(200);
    expect(supervisor.body.allowedStatusTransitions).toEqual([]);

    const admin = await request(app.getHttpServer())
      .get(`/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .expect(200);
    expect(admin.body.allowedStatusTransitions).toEqual(['in_progress', 'pending_customer', 'resolved']);
  });
});
