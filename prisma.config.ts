// Prisma 7 ya no lee la URL desde schema.prisma ni carga .env por su cuenta.
// La URL vive solo aquí, tomada del entorno: nunca hardcodeada en el repo.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
