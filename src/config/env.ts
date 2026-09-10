// Configuración por entorno. Ningún valor sensible tiene default: si falta un
// secreto, la aplicación no arranca. Un default silencioso en un secreto es
// cómo acaba una clave conocida corriendo en producción.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Falla al arrancar, con el nombre de la variable que falta. */
function requerido(valor: string | undefined, nombre: string): string {
  if (valor === undefined || valor.trim() === '') {
    throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  return valor;
}

@Injectable()
export class EnvService {
  constructor(private readonly config: ConfigService) {}

  get nodeEnv(): string {
    return this.config.get<string>('NODE_ENV') ?? 'development';
  }

  get esProduccion(): boolean {
    return this.nodeEnv === 'production';
  }

  /**
   * Swagger UI en /docs. Por defecto activa salvo en producción: publicar la
   * superficie completa de la API ahí es información gratis para quien mire.
   */
  get docsHabilitados(): boolean {
    const valor = this.config.get<string>('DOCS_ENABLED');
    if (valor === undefined || valor.trim() === '') return !this.esProduccion;
    return valor.trim() === 'true';
  }

  get puerto(): number {
    return Number(this.config.get<string>('PORT') ?? 3000);
  }

  get databaseUrl(): string {
    return requerido(this.config.get<string>('DATABASE_URL'), 'DATABASE_URL');
  }

  get jwtAccessSecret(): string {
    return requerido(this.config.get<string>('JWT_ACCESS_SECRET'), 'JWT_ACCESS_SECRET');
  }

  /** Segundos. El TTL corto es la ventana máxima de un token ya emitido. */
  get accessTtlSegundos(): number {
    return this.duracionASegundos(this.config.get<string>('JWT_ACCESS_TTL') ?? '15m');
  }

  get refreshTtlSegundos(): number {
    return this.duracionASegundos(this.config.get<string>('JWT_REFRESH_TTL') ?? '7d');
  }

  /** KiB de memoria para argon2id. El coste alto es el punto de la función. */
  get argonMemoryCost(): number {
    return Number(this.config.get<string>('ARGON_MEMORY_COST') ?? 19456);
  }

  /**
   * Lista blanca de orígenes. Nunca `*`: con credenciales de por medio el
   * comodín hace que el navegador descarte la respuesta entera.
   */
  get corsOrigins(): string[] {
    return requerido(this.config.get<string>('CORS_ORIGIN'), 'CORS_ORIGIN')
      .split(',')
      .map((origen) => origen.trim())
      .filter((origen) => origen.length > 0);
  }

  /** Intentos fallidos antes de bloquear temporalmente la cuenta. */
  get maxIntentosFallidos(): number {
    return Number(this.config.get<string>('AUTH_MAX_FAILED_ATTEMPTS') ?? 5);
  }

  get bloqueoMinutos(): number {
    return Number(this.config.get<string>('AUTH_LOCKOUT_MINUTES') ?? 15);
  }

  /** Acepta "900", "15m", "7d", "12h". */
  private duracionASegundos(valor: string): number {
    const coincidencia = /^(\d+)([smhd]?)$/.exec(valor.trim());
    if (coincidencia === null) {
      throw new Error(`Duración inválida: "${valor}". Formatos válidos: 900, 15m, 12h, 7d`);
    }
    const cantidad = Number(coincidencia[1]);
    const factores: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
    return cantidad * (factores[coincidencia[2] ?? ''] ?? 1);
  }
}
