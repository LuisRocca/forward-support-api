// Dobles compartidos por los unitarios de auth. Solo implementan lo que
// TokenService y JwtAuthGuard usan de Prisma, en memoria.
import type { EnvService } from '../config/env.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface FilaRefresh {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface FilaUsuario {
  id: string;
  status: 'active' | 'blocked' | 'inactive';
  tokenVersion: number;
  blockedReason: string | null;
  deletedAt: Date | null;
  roles: string[];
}

export function envDePrueba(): EnvService {
  return {
    jwtAccessSecret: 'secreto-solo-para-tests-unitarios-0123456789',
    accessTtlSegundos: 900,
    refreshTtlSegundos: 3600,
  } as unknown as EnvService;
}

function coincide(fila: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(
    ([clave, valor]) => (fila as Record<string, unknown>)[clave] === valor,
  );
}

export function prismaEnMemoria(usuarios: FilaUsuario[] = []): {
  prisma: PrismaService;
  refresh: FilaRefresh[];
} {
  const refresh: FilaRefresh[] = [];
  let secuencia = 0;

  const refreshToken = {
    create: async ({ data }: { data: Omit<FilaRefresh, 'id' | 'revokedAt' | 'revokedReason'> }) => {
      const fila: FilaRefresh = { id: String(++secuencia), revokedAt: null, revokedReason: null, ...data };
      refresh.push(fila);
      return fila;
    },
    findUnique: async ({ where }: { where: { tokenHash: string } }) =>
      refresh.find((fila) => fila.tokenHash === where.tokenHash) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Partial<FilaRefresh> }) => {
      const fila = refresh.find((f) => f.id === where.id);
      if (fila === undefined) throw new Error(`refresh ${where.id} no existe`);
      return Object.assign(fila, data);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<FilaRefresh> }) => {
      const afectadas = refresh.filter((fila) => coincide(fila, where));
      for (const fila of afectadas) Object.assign(fila, data);
      return { count: afectadas.length };
    },
  };

  const user = {
    findFirst: async ({ where }: { where: { id: string; deletedAt: null } }) => {
      const fila = usuarios.find((u) => u.id === where.id && u.deletedAt === null);
      if (fila === undefined) return null;
      return { ...fila, roles: fila.roles.map((code) => ({ role: { code } })) };
    },
  };

  // Prisma ejecuta el array de operaciones en una transacción; aquí basta con
  // esperarlas todas.
  const $transaction = async (operaciones: Promise<unknown>[]) => Promise.all(operaciones);

  return { prisma: { refreshToken, user, $transaction } as unknown as PrismaService, refresh };
}
