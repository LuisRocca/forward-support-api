import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { envDePrueba, prismaEnMemoria } from '../test-doubles.js';
import type { FilaUsuario } from '../test-doubles.js';
import { TokenService } from '../token.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const activo: FilaUsuario = {
  id: 'u1',
  status: 'active',
  tokenVersion: 2,
  blockedReason: null,
  deletedAt: null,
  roles: ['agent'],
};

function montar(usuarios: FilaUsuario[], esPublico = false) {
  const { prisma } = prismaEnMemoria(usuarios);
  const tokens = new TokenService(new JwtService({}), envDePrueba(), prisma);
  const reflector = { getAllAndOverride: () => esPublico } as unknown as Reflector;
  return { guard: new JwtAuthGuard(reflector, tokens, prisma), tokens };
}

function contexto(autorizacion?: string): { ctx: ExecutionContext; peticion: Request } {
  const peticion = { headers: autorizacion === undefined ? {} : { authorization: autorizacion } } as Request;
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => peticion }),
  } as unknown as ExecutionContext;
  return { ctx, peticion };
}

async function bearer(tokens: TokenService, tokenVersion: number, roles: string[] = ['agent']) {
  const { token } = await tokens.emitirAccessToken({ sub: 'u1', tokenVersion, roles });
  return `Bearer ${token}`;
}

describe('JwtAuthGuard — los códigos de 401 que el cliente distingue', () => {
  afterEach(() => vi.useRealTimers());

  it('sin cabecera → AUTH_TOKEN_INVALID', async () => {
    const { guard } = montar([activo]);
    await expect(guard.canActivate(contexto().ctx)).rejects.toMatchObject({ codigo: 'AUTH_TOKEN_INVALID' });
  });

  it('token ilegible → AUTH_TOKEN_INVALID, nunca EXPIRED (evita el bucle de refresh)', async () => {
    const { guard } = montar([activo]);
    await expect(guard.canActivate(contexto('Bearer basura').ctx)).rejects.toMatchObject({
      codigo: 'AUTH_TOKEN_INVALID',
    });
  });

  it('token caducado → AUTH_TOKEN_EXPIRED', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { guard, tokens } = montar([activo]);
    const cabecera = await bearer(tokens, 2);
    vi.setSystemTime(Date.now() + 16 * 60_000);

    await expect(guard.canActivate(contexto(cabecera).ctx)).rejects.toMatchObject({
      codigo: 'AUTH_TOKEN_EXPIRED',
    });
  });

  it('tokenVersion distinta de la de la base → AUTH_TOKEN_REVOKED', async () => {
    const { guard, tokens } = montar([activo]);
    const cabecera = await bearer(tokens, 1); // la base dice 2

    await expect(guard.canActivate(contexto(cabecera).ctx)).rejects.toMatchObject({
      codigo: 'AUTH_TOKEN_REVOKED',
    });
  });

  it('usuario bloqueado con token válido y versión correcta → AUTH_USER_BLOCKED', async () => {
    const { guard, tokens } = montar([{ ...activo, status: 'blocked', blockedReason: 'Motivo' }]);
    const cabecera = await bearer(tokens, 2);

    await expect(guard.canActivate(contexto(cabecera).ctx)).rejects.toMatchObject({
      codigo: 'AUTH_USER_BLOCKED',
      detalle: 'Motivo',
    });
  });

  it('usuario borrado → AUTH_TOKEN_REVOKED', async () => {
    const { guard, tokens } = montar([{ ...activo, deletedAt: new Date() }]);
    const cabecera = await bearer(tokens, 2);

    await expect(guard.canActivate(contexto(cabecera).ctx)).rejects.toMatchObject({
      codigo: 'AUTH_TOKEN_REVOKED',
    });
  });

  it('válido: deja pasar y adjunta los roles de la BASE, no los del token', async () => {
    const { guard, tokens } = montar([{ ...activo, roles: ['agent'] }]);
    // El token dice admin, pero en la base ya solo es agente.
    const { ctx, peticion } = contexto(await bearer(tokens, 2, ['admin']));

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(peticion.usuario).toEqual({ id: 'u1', roles: ['agent'] });
  });

  it('una ruta @Publico() pasa sin token', async () => {
    const { guard } = montar([], true);
    await expect(guard.canActivate(contexto().ctx)).resolves.toBe(true);
  });
});
