// End to end contra la aplicación real, con su filtro de excepciones, sus
// guards y su pipe de validación montados. Comprueba el contrato de errores:
// es lo que el front consume en cada respuesta que no sea un 2xx.
//
// Usa la base de pruebas (DATABASE_URL_TEST), no la de desarrollo.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import cookieParser from 'cookie-parser';

import { AppModule } from './../src/app.module.js';
import { crearValidationPipe } from './../src/common/problem/validation.pipe.js';

describe('Auth (e2e)', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = process.env['DATABASE_URL_TEST'] ?? process.env['DATABASE_URL'];

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(crearValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('una ruta protegida sin token responde 401 en formato RFC 9457', async () => {
    const respuesta = await request(app.getHttpServer()).get('/auth/me').expect(401);

    expect(respuesta.headers['content-type']).toContain('application/problem+json');
    expect(respuesta.body).toMatchObject({
      status: 401,
      code: 'AUTH_TOKEN_INVALID',
      instance: '/auth/me',
    });
    // El traceId es lo que permite correlacionar con el log del servidor.
    expect(typeof respuesta.body.traceId).toBe('string');
    expect(typeof respuesta.body.type).toBe('string');
    expect(typeof respuesta.body.title).toBe('string');
  });

  it('un token ilegible NO se reporta como expirado', async () => {
    // La distinción importa: con AUTH_TOKEN_EXPIRED el cliente reintenta el
    // refresh, y hacerlo con un token roto es un bucle.
    const respuesta = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer esto-no-es-un-jwt')
      .expect(401);

    expect(respuesta.body.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('el login con un cuerpo inválido responde 422 con el detalle por campo', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'no-es-un-email', password: 'corta' })
      .expect(422);

    expect(respuesta.body.code).toBe('VALIDATION_ERROR');
    expect(respuesta.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'email' }),
        expect.objectContaining({ field: 'password' }),
      ]),
    );
  });

  it('el login con credenciales inexistentes responde igual que con contraseña incorrecta', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nadie@forward.test', password: 'unaPasswordCualquiera' })
      .expect(401);

    // Nunca debe revelarse si el email existe: permitiría enumerar cuentas.
    expect(respuesta.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(JSON.stringify(respuesta.body)).not.toMatch(/no existe|not found|unknown/i);
  });
});
