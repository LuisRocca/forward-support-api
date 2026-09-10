// Primero, siempre: ver src/config/load-env.ts.
import './config/load-env.js';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module.js';
import { crearValidationPipe } from './common/problem/validation.pipe.js';
import { montarDocumentacion } from './docs/docs.js';
import { EnvService } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const env = app.get(EnvService);

  app.use(cookieParser());
  app.useGlobalPipes(crearValidationPipe());

  // Detrás de un proxy, sin esto req.ip es la IP del proxy y el rate limiting
  // por IP se vuelve un límite global compartido por todos los usuarios.
  app.set('trust proxy', 1);

  app.enableCors({
    // Lista blanca explícita. Nunca '*': con credentials el navegador descarta
    // la respuesta entera si el origen es un comodín.
    origin: env.corsOrigins,
    credentials: true,
    // Sin esto el navegador recibe Retry-After y se la oculta al cliente.
    exposedHeaders: ['Retry-After'],
  });

  if (env.docsHabilitados) montarDocumentacion(app);

  // Sin esto, SIGTERM no cierra el proceso: en un contenedor Node es el PID 1 y
  // no trae manejador por defecto para esa señal. ECS manda SIGTERM al
  // desplegar o reducir tareas y, pasado su timeout, SIGKILL: sin cierre
  // ordenado se cortan las peticiones en curso y la conexión con la base.
  // Con los hooks, Nest deja de aceptar peticiones, ejecuta onModuleDestroy
  // (Prisma se desconecta) y el proceso sale.
  app.enableShutdownHooks();

  await app.listen(env.puerto);
}

await bootstrap();
