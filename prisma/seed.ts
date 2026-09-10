// Seed de desarrollo.
//
// Dos mitades con criterios distintos:
//   - Catálogos y usuarios van por el cliente de Prisma: son pocas filas, se
//     leen mejor tipadas y de paso comprueban que el cliente generado funciona.
//   - Los ~100.000 tickets y su trazabilidad van en SQL (prisma/seed-tickets.sql).
//     Fila por fila desde Node serían cientos de miles de viajes de ida y vuelta.
//
// Es idempotente en los catálogos (upsert) y regenera los tickets desde cero en
// cada ejecución: el volumen solo sirve si la distribución es la esperada.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

/** Cuántos tickets genera el seed. Override: TICKETS=5000 pnpm db:seed */
const TICKETS = Number(process.env['TICKETS'] ?? 100_000);

/**
 * Los usuarios del seed NO pueden iniciar sesión: se guarda un marcador, no un
 * hash. Inventar un hash de una password conocida metería una credencial válida
 * en el repositorio. Los hashes reales (argon2id) los siembra el módulo de auth.
 */
const SIN_CREDENCIAL = 'PLACEHOLDER::sin-credencial-hasta-el-modulo-de-auth';

const ROLES = [
  { code: 'admin', name: 'Administrador', description: 'Acceso total, administra usuarios y catálogos.' },
  { code: 'supervisor', name: 'Supervisor', description: 'Asigna y reasigna tickets, ve la operación completa.' },
  { code: 'agent', name: 'Agente', description: 'Atiende los tickets que tiene asignados.' },
] as const;

const CATEGORIAS = [
  { code: 'acceso', name: 'Acceso y credenciales', defaultPriority: 'high' },
  { code: 'facturacion', name: 'Facturación', defaultPriority: 'high' },
  { code: 'errores', name: 'Errores de aplicación', defaultPriority: 'critical' },
  { code: 'rendimiento', name: 'Rendimiento', defaultPriority: 'medium' },
  { code: 'datos', name: 'Corrección de datos', defaultPriority: 'medium' },
  { code: 'integraciones', name: 'Integraciones', defaultPriority: 'high' },
  { code: 'consultas', name: 'Consultas y capacitación', defaultPriority: 'low' },
  { code: 'solicitudes', name: 'Solicitudes de cambio', defaultPriority: 'low' },
] as const;

const RAZONES_SOCIALES = [
  'Comercial', 'Distribuidora', 'Industrias', 'Servicios', 'Grupo', 'Corporación',
  'Transportes', 'Constructora', 'Alimentos', 'Textiles', 'Farmacéutica', 'Agrícola',
];
const APELLIDOS = [
  'Andina', 'del Valle', 'Pacífico', 'Norte', 'Central', 'Austral', 'Litoral',
  'Sierra', 'Delta', 'Meridiana', 'Continental', 'Atlántica', 'Global', 'Unida',
  'Integral', 'Regional', 'Nacional', 'Oriental', 'Occidental', 'Metropolitana',
];
const SUFIJOS = ['S.A.', 'S.A.S.', 'Ltda.', 'C.A.', 'S.R.L.'];

const NOMBRES = [
  'Ana', 'Luis', 'Carmen', 'Javier', 'Marta', 'Diego', 'Lucía', 'Andrés', 'Sofía',
  'Pablo', 'Elena', 'Miguel', 'Laura', 'Sergio', 'Paula', 'Álvaro', 'Irene',
  'Rubén', 'Nuria', 'Óscar', 'Beatriz', 'Hugo', 'Clara', 'Iván', 'Rocío',
  'Adrián', 'Silvia', 'Tomás', 'Verónica', 'Gonzalo', 'Alicia', 'Mateo',
  'Patricia', 'Emilio', 'Natalia', 'Raúl', 'Teresa', 'Víctor', 'Julia', 'Dani',
];
const APELLIDOS_PERSONA = [
  'García', 'Rodríguez', 'Martínez', 'López', 'Sánchez', 'Pérez', 'Gómez', 'Díaz',
  'Fernández', 'Moreno', 'Álvarez', 'Romero', 'Navarro', 'Torres', 'Ramírez',
  'Vargas', 'Castro', 'Ortiz', 'Rubio', 'Molina',
];

/** 200 clientes con nombres distintos, derivados de forma determinista. */
function generarClientes(total: number) {
  return Array.from({ length: total }, (_, i) => {
    const razon = RAZONES_SOCIALES[i % RAZONES_SOCIALES.length];
    const apellido = APELLIDOS[Math.floor(i / RAZONES_SOCIALES.length) % APELLIDOS.length];
    const sufijo = SUFIJOS[i % SUFIJOS.length];
    return {
      name: `${razon} ${apellido} ${sufijo}`,
      taxId: `NIT-${String(900_000_000 + i * 7).slice(0, 9)}-${i % 10}`,
      email: `contacto${i + 1}@cliente-ejemplo.test`,
      phone: `+57 300 ${String(1_000_000 + i * 13).slice(0, 7)}`,
    };
  });
}

function nombrePersona(i: number): string {
  const nombre = NOMBRES[i % NOMBRES.length];
  // Paso de 7 sobre 20 apellidos: 7 y 20 son coprimos, así que recorre los 20
  // antes de repetir. Dividir por NOMBRES.length daría 0 para los 40 usuarios
  // y todos se llamarían igual de apellido.
  const apellido = APELLIDOS_PERSONA[(i * 7) % APELLIDOS_PERSONA.length];
  return `${nombre} ${apellido}`;
}

/** 1 admin, 4 supervisores y 35 agentes. */
function generarUsuarios() {
  const usuarios: { email: string; fullName: string; role: string }[] = [
    { email: 'admin@forward.test', fullName: nombrePersona(0), role: 'admin' },
  ];
  for (let i = 1; i <= 4; i++) {
    usuarios.push({ email: `supervisor${i}@forward.test`, fullName: nombrePersona(i), role: 'supervisor' });
  }
  for (let i = 1; i <= 35; i++) {
    usuarios.push({ email: `agente${i}@forward.test`, fullName: nombrePersona(i + 4), role: 'agent' });
  }
  return usuarios;
}

async function sembrarCatalogos(prisma: PrismaClient): Promise<void> {
  for (const rol of ROLES) {
    await prisma.role.upsert({
      where: { code: rol.code },
      update: { name: rol.name, description: rol.description },
      create: { ...rol, isSystem: true },
    });
  }

  for (const categoria of CATEGORIAS) {
    await prisma.ticketCategory.upsert({
      where: { code: categoria.code },
      update: { name: categoria.name },
      create: categoria,
    });
  }

  for (const cliente of generarClientes(200)) {
    await prisma.client.upsert({
      where: { taxId: cliente.taxId },
      update: { name: cliente.name },
      create: cliente,
    });
  }
}

async function sembrarUsuarios(prisma: PrismaClient): Promise<void> {
  const roles = await prisma.role.findMany({ select: { id: true, code: true } });
  const idPorRol = new Map(roles.map((r) => [r.code, r.id]));

  for (const usuario of generarUsuarios()) {
    const roleId = idPorRol.get(usuario.role);
    if (roleId === undefined) throw new Error(`Rol inexistente: ${usuario.role}`);

    const creado = await prisma.user.upsert({
      where: { email: usuario.email },
      update: { fullName: usuario.fullName },
      create: {
        email: usuario.email,
        fullName: usuario.fullName,
        passwordHash: SIN_CREDENCIAL,
        status: 'active',
      },
      select: { id: true },
    });

    // assignedByUserId queda NULL: lo asigna el sistema, no una persona.
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: creado.id, roleId } },
      update: {},
      create: { userId: creado.id, roleId },
    });
  }
}

/**
 * Ejecuta prisma/seed-tickets.sql. El archivo trae varias sentencias separadas
 * por la marca "-- >>>" y todas van en una sola transacción: si algo falla, no
 * queda un volumen a medias que invalide las mediciones.
 */
async function sembrarTickets(prisma: PrismaClient): Promise<void> {
  const aqui = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(aqui, 'seed-tickets.sql'), 'utf8');

  const sentencias = sql
    .split(/^-- >>>$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--.*\n?)*$/.test(s));

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('seed.tickets', $1, true)`, String(TICKETS));
      for (const sentencia of sentencias) {
        await tx.$executeRawUnsafe(sentencia);
      }
    },
    { timeout: 15 * 60 * 1000 },
  );
}

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log('Sembrando catálogos (roles, categorías, clientes)...');
    await sembrarCatalogos(prisma);

    console.log('Sembrando usuarios y roles...');
    await sembrarUsuarios(prisma);

    console.log(`Generando ${TICKETS.toLocaleString('es')} tickets y su trazabilidad...`);
    const inicio = Date.now();
    await sembrarTickets(prisma);
    console.log(`Listo en ${((Date.now() - inicio) / 1000).toFixed(1)}s`);

    const [tickets, asignaciones, historial, comentarios] = await Promise.all([
      prisma.ticket.count(),
      prisma.ticketAssignment.count(),
      prisma.ticketStatusHistory.count(),
      prisma.ticketComment.count(),
    ]);
    console.table({ tickets, asignaciones, historial, comentarios });
  } finally {
    await prisma.$disconnect();
  }
}

await main();
