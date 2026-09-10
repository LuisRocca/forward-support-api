// Carga .env ANTES que cualquier otro módulo. Tiene que ser el primer import de
// main.ts: en ESM los imports se evalúan antes que el código del fichero, y
// hay valores que se leen al cargar el módulo (los límites de @Throttle, que es
// un decorador, y ThrottlerModule.forRoot). Si .env se cargara después, esos
// valores caerían en silencio a su default.
//
// process.loadEnvFile es nativo de Node: sin dependencia. No sobrescribe
// variables ya definidas, así que en producción manda el entorno real.
import { existsSync } from 'node:fs';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
