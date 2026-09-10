// Migra la base de pruebas antes de la suite e2e.
//
// La base de test vive en tmpfs: tras reiniciar el host o el contenedor vuelve
// VACÍA, y la suite fallaría con errores de tablas inexistentes que no dicen
// nada del código. `migrate deploy` es idempotente: si ya está al día, no hace nada.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export default function setup(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');

  const url = process.env['DATABASE_URL_TEST'];
  // Seguro contra el peor error posible aquí: migrar o ensuciar la base de
  // desarrollo creyendo que es la de pruebas.
  if (url === undefined || !/\/[^/?]+_test(\?|$)/.test(url)) {
    throw new Error(
      'DATABASE_URL_TEST falta o no apunta a una base cuyo nombre acabe en _test. La suite e2e no se ejecuta.',
    );
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
