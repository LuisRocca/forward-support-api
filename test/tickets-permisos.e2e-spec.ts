// El supervisor no edita tickets: PATCH /tickets/{id} es solo de admin y del
// agente sobre los suyos. Se contrasta con el admin sobre el MISMO id
// inexistente: si el admin recibe 404 y el supervisor 403, el 403 sale del rol
// y no de que el ticket no exista.
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
  });

  afterAll(async () => {
    const usuarios = { email: { in: Object.values(EMAILS) } };
    await prisma.auditLog.deleteMany({ where: { actor: usuarios } });
    await prisma.user.deleteMany({ where: usuarios });
    await app.close();
  });

  it('el supervisor recibe 403 al editar un ticket', async () => {
    const token = await login(EMAILS.supervisor);
    const respuesta = await request(app.getHttpServer())
      .patch(`/tickets/${TICKET_INEXISTENTE}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priority: 'high' })
      .expect(403);

    expect(respuesta.body.code).toBe('FORBIDDEN');
  });

  it('el admin, con el mismo id, pasa el permiso y llega al 404', async () => {
    const token = await login(EMAILS.admin);
    const respuesta = await request(app.getHttpServer())
      .patch(`/tickets/${TICKET_INEXISTENTE}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priority: 'high' })
      .expect(404);

    expect(respuesta.body.code).toBe('NOT_FOUND');
  });
});
