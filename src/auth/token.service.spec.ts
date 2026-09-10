import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';

import { envDePrueba, prismaEnMemoria } from './test-doubles.js';
import { TokenService } from './token.service.js';

function crear() {
  const { prisma, refresh } = prismaEnMemoria();
  const servicio = new TokenService(new JwtService({}), envDePrueba(), prisma);
  return { servicio, refresh };
}

const sha256 = (valor: string): string => createHash('sha256').update(valor).digest('hex');

describe('TokenService — access token', () => {
  afterEach(() => vi.useRealTimers());

  it('lleva sub, tokenVersion y roles, y caduca en 15 minutos', async () => {
    const { servicio } = crear();
    const { token, expiraEn } = await servicio.emitirAccessToken({ sub: 'u1', tokenVersion: 3, roles: ['agent'] });

    expect(expiraEn).toBe(900);
    await expect(servicio.verificarAccessToken(token)).resolves.toMatchObject({
      sub: 'u1',
      tokenVersion: 3,
      roles: ['agent'],
    });
  });

  it('pasados los 15 minutos, la verificación falla como EXPIRADO y no como token roto', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { servicio } = crear();
    const { token } = await servicio.emitirAccessToken({ sub: 'u1', tokenVersion: 0, roles: [] });

    vi.setSystemTime(Date.now() + 16 * 60_000);
    // El nombre es lo que usa el guard para devolver AUTH_TOKEN_EXPIRED; si
    // cambiara, el cliente entraría en un bucle de refresh.
    await expect(servicio.verificarAccessToken(token)).rejects.toMatchObject({ name: 'TokenExpiredError' });
  });

  it('un token firmado con otro secreto falla, y NO como expirado', async () => {
    const { servicio } = crear();
    const ajeno = await new JwtService({}).signAsync({ sub: 'u1' }, { secret: 'otro-secreto' });

    const error = await servicio.verificarAccessToken(ajeno).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe('TokenExpiredError');
  });
});

describe('TokenService — refresh token', () => {
  it('en base se guarda el SHA-256, nunca el token plano', async () => {
    const { servicio, refresh } = crear();
    const { token } = await servicio.emitirRefreshToken('u1', {});

    expect(refresh).toHaveLength(1);
    expect(refresh[0]?.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(refresh)).not.toContain(token);
  });

  it('rotar invalida el usado y emite otro de la MISMA familia', async () => {
    const { servicio, refresh } = crear();
    const { token } = await servicio.emitirRefreshToken('u1', {});

    const rotado = await servicio.rotar(token, {});

    expect(rotado?.userId).toBe('u1');
    expect(rotado?.refresh.token).not.toBe(token);
    const [viejo, nuevo] = refresh;
    expect(viejo).toMatchObject({ revokedReason: 'rotated' });
    expect(viejo?.revokedAt).not.toBeNull();
    expect(nuevo).toMatchObject({ revokedAt: null, familyId: viejo?.familyId });
  });

  it('reusar un token ya rotado revoca la familia ENTERA, incluida la sesión nueva', async () => {
    const { servicio, refresh } = crear();
    const { token } = await servicio.emitirRefreshToken('u1', {});
    const rotado = await servicio.rotar(token, {});

    await expect(servicio.rotar(token, {})).resolves.toBeNull();

    expect(refresh.every((fila) => fila.revokedAt !== null)).toBe(true);
    expect(refresh[1]?.revokedReason).toBe('reuse_detected');
    // Y el token legítimo más reciente ya no sirve.
    await expect(servicio.rotar(rotado?.refresh.token ?? '', {})).resolves.toBeNull();
  });

  it('la revocación por reuso no toca otras familias del mismo usuario', async () => {
    const { servicio, refresh } = crear();
    const primera = await servicio.emitirRefreshToken('u1', {});
    await servicio.emitirRefreshToken('u1', {}); // otra sesión, otra familia
    await servicio.rotar(primera.token, {});

    await servicio.rotar(primera.token, {}); // reuso en la primera familia

    const otraFamilia = refresh[1];
    expect(otraFamilia?.revokedAt).toBeNull();
  });

  it('un token caducado o desconocido no rota', async () => {
    const { servicio, refresh } = crear();
    const { token } = await servicio.emitirRefreshToken('u1', {});
    const fila = refresh[0];
    if (fila !== undefined) fila.expiresAt = new Date(Date.now() - 1000);

    await expect(servicio.rotar(token, {})).resolves.toBeNull();
    await expect(servicio.rotar('no-existe', {})).resolves.toBeNull();
  });
});
