# Plataforma de Soporte — API

API REST para la gestión de tickets de soporte: registrar, consultar, asignar
y dar seguimiento, con trazabilidad y control de acceso por rol.

Prueba técnica — Tech Lead Full Stack JavaScript.
Frontend en un repositorio aparte (`erp_forward`).

## Stack

| Capa | Elección |
|---|---|
| Runtime | Node.js 24 |
| Framework | NestJS 12 · TypeScript strict |
| Base de datos | PostgreSQL 18 |
| ORM / migraciones | Prisma 7 (driver adapter `pg`) |
| Tests | Vitest (unitarios + e2e) |
| Lint / formato | oxlint (`--type-aware`) · Prettier |
| Paquetes | pnpm |

## Puesta en marcha

```bash
pnpm install
cp .env.example .env          # ajustar los secretos JWT
pnpm db:up                    # levanta Postgres dev + test
pnpm db:migrate               # aplica las migraciones
pnpm db:seed                  # ~100.000 tickets con distribución realista
pnpm start:dev
```

| Servicio | Puerto | Notas |
|---|---|---|
| API | 3000 | corre fuera del contenedor, con hot reload |
| Postgres dev | **5442** | persistente en volumen |
| Postgres test | **5443** | efímero, en RAM |
| Adminer | 8080 | opcional: `pnpm db:tools` |

Puertos 5442/5443 en lugar de los habituales 5432/5433 a propósito: una máquina
de desarrollo casi siempre tiene ya un Postgres local u otro proyecto ocupándolos.

### Scripts de base de datos

```bash
pnpm db:up       # levantar dev + test
pnpm db:down     # parar (conserva los datos de dev)
pnpm db:reset    # borrar volúmenes y empezar de cero
pnpm db:psql     # abrir psql contra la base de desarrollo
pnpm db:logs     # seguir los logs de Postgres
```

### Esquema y datos

```bash
pnpm db:migrate         # crear/aplicar migraciones (prisma migrate dev)
pnpm db:migrate:deploy  # aplicar sin generar (despliegue)
pnpm db:generate        # regenerar el cliente en generated/prisma
pnpm db:seed            # sembrar datos
```

El seed son dos mitades: catálogos y usuarios por el cliente de Prisma
(idempotentes, con `upsert`) y los tickets en SQL, porque son ~100.000 filas más
su trazabilidad y hacerlo desde Node serían cientos de miles de idas y vueltas.
Tarda unos 25 segundos y es reproducible (`setseed`). Regenera los tickets desde
cero en cada ejecución; para un volumen menor, `TICKETS=5000 pnpm db:seed`.

Los usuarios sembrados **no pueden iniciar sesión**: en `password_hash` queda un
marcador, no un hash. Meter el hash de una password conocida en el repositorio es
meter una credencial válida en el repositorio. Los hashes reales (argon2id) los
siembra el módulo de autenticación.

## Entornos de base de datos

Dos instancias, con propósitos distintos:

- **`db`** — desarrollo. Volumen persistente, configuración por defecto.
- **`db_test`** — pruebas de integración. Vive en `tmpfs` (RAM) y arranca con
  `fsync=off`, `synchronous_commit=off` y `full_page_writes=off`. Se pierde
  al parar el contenedor, que es exactamente lo que se quiere de una base de
  pruebas, y a cambio la suite corre notablemente más rápido. Esa configuración
  sería inaceptable en producción: sacrifica durabilidad ante un corte.

El script `docker/postgres/init/01-extensions.sql` se ejecuta una única vez, al
inicializar el volumen, e instala `citext` y `pg_trgm`.

## Autenticación

Dos tokens con propósitos distintos:

| | Vida | Dónde viaja | Dónde se guarda |
|---|---|---|---|
| Access (JWT) | 15 min | `Authorization: Bearer` | en memoria del cliente, **nunca** en `localStorage` |
| Refresh (opaco) | 7 días | cookie `httpOnly` | en base, solo su SHA-256 |

El access token lleva el claim `tokenVersion` y el guard **lo compara contra
Postgres en cada petición**. Es un lookup por clave primaria, y a cambio
bloquear a un usuario surte efecto de inmediato en vez de "hasta dentro de un
cuarto de hora". Cuando el volumen lo justifique, esa lectura se mueve a Redis
sin tocar nada más.

El refresh **rota en cada uso**. Si llega uno ya rotado se asume robo —el
legítimo y el ladrón no pueden usar el mismo token dos veces— y se revoca la
familia entera de sesiones.

### Cuentas de prueba

El seed activa tres cuentas **sobre usuarios que ya existen y ya tienen datos**,
en vez de crear cuentas nuevas: un usuario recién creado entra y ve la bandeja
vacía, y esa prueba no demuestra nada.

```bash
# En .env, sin valor por defecto: el seed falla si falta.
SEED_PASSWORD=<la que quieras, mínimo 8 caracteres>
pnpm db:seed
```

Al terminar imprime los tres emails. Hoy son `admin@forward.test`,
`supervisor1@forward.test` y el agente con más carga real de los 100.000
tickets, que es el que encabeza la consulta 6.

El resto de los 40 usuarios **no pueden iniciar sesión**: en `password_hash`
tienen un marcador, no un hash. Meter en el repositorio el hash de una
contraseña conocida es meter una credencial válida en el repositorio.

### Errores

Todas las respuestas de error, incluidos los 500, siguen **RFC 9457**
(`application/problem+json`). El campo `code` es el identificador estable sobre
el que ramifica el cliente; `title` es texto para humanos y puede cambiar.

Los tres códigos de 401 se distinguen a propósito, porque reintentar el refresh
cuando la sesión está revocada es un bucle infinito:

| `code` | Qué hace el cliente |
|---|---|
| `AUTH_TOKEN_EXPIRED` | renueva en `/auth/refresh` y reintenta una vez |
| `AUTH_TOKEN_REVOKED` | cierra sesión |
| `AUTH_USER_BLOCKED` | cierra sesión y muestra el motivo |
| `AUTH_TOKEN_INVALID` | token ausente o ilegible: cierra sesión |

## Documentación de la API

Swagger UI en **`http://localhost:3000/docs`**, servida desde
`docs/api-contract.yaml` tal cual: no se genera otro contrato desde
decoradores, porque la fuente de verdad compartida con el front es el YAML. El
fichero crudo está en `/docs/openapi.yaml`.

Activa por defecto salvo con `NODE_ENV=production`; `DOCS_ENABLED=true` o
`false` lo fuerza. En producción está apagada a propósito: publicar la
superficie completa de la API es información gratis para quien mire.

## Imagen Docker

```bash
docker build --format docker -t forward-api .                          # API
docker build --format docker --target migrate -t forward-api-migrate . # migraciones
```

`--format docker` hace falta con podman: en formato OCI se ignora el `HEALTHCHECK`.

- **Multi-etapa.** Se compila con las dependencias de desarrollo; la imagen final
  lleva solo `dist`, las dependencias de producción y `package.json`.
- **Sin secretos.** Todo entra por variables de entorno en ejecución: como
  mínimo `DATABASE_URL`, `JWT_ACCESS_SECRET` y `CORS_ORIGIN` (en AWS, desde
  Secrets Manager en la task definition). La misma imagen sirve para todos los
  entornos. `.dockerignore` excluye `.env` del contexto de build.
- **Sin root.** Corre como el usuario `node` (uid 1000).
- **`HEALTHCHECK`** contra `/health`, con `node` y `fetch`, sin instalar curl.
- **Cierre ordenado.** Sale con `SIGTERM` en ~2 s (lo que manda ECS al
  desplegar), gracias a `enableShutdownHooks()`.
- **Migraciones aparte.** La imagen de la API no lleva el CLI de prisma para
  migrar. La etapa `migrate` es una tarea puntual de ECS que ejecuta
  `prisma migrate deploy` antes de desplegar la nueva versión.

Tamaño: 539 MB, de los que ~200 MB son herramientas que entran por un peer
opcional de `@prisma/client` y no se usan en runtime. Causa, lo que se probó y
las salidas posibles en `docs/KNOWN_ISSUES.md`.

## Healthcheck

`GET /health` es público, no pasa por el rate limiting y responde:

| Estado | Cuándo |
|---|---|
| `200 {"status":"ok","database":"up"}` | la base responde a `SELECT 1` en menos de 2 s |
| `503` (RFC 9457, `SERVICE_UNAVAILABLE`) | la base no responde o tarda más |

Es el que usan el balanceador (ALB) y el `HEALTHCHECK` de la imagen. No va
limitado porque un 429 haría que el balanceador diera la instancia por caída,
y tiene timeout propio porque un healthcheck que no contesta es peor que uno
que dice 503. El error de la base no aparece en la respuesta: el endpoint es
público.

## Calidad

```bash
pnpm lint        # oxlint --type-aware sobre src/, test/, prisma/
pnpm typecheck   # tsc --noEmit sobre el proyecto entero
pnpm build       # nest build (solo src/)
pnpm test        # unitarios
pnpm test:e2e    # end to end
```

`lint` y `typecheck` no son redundantes con `build`: `nest build` compila solo
`src/`, así que por sí solo no garantiza que el proyecto entero tipe. Y el lint
corre con `--type-aware` porque `no-floating-promises` y `no-misused-promises`
necesitan tipos: sin ese flag se aceptan en la configuración y no detectan nada.

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/DECISIONES-TECNICAS.md`](docs/DECISIONES-TECNICAS.md) | Decisiones de arquitectura y modelo, cada una con su justificación, su costo asumido y las condiciones bajo las que la cambiaría. |
| [`docs/modelo-er-soporte.ddb`](docs/modelo-er-soporte.ddb) | Modelo entidad-relación. Se abre en [drawdb.app](https://drawdb.app) con *File → Import diagram*. |
| [`queries.sql`](queries.sql) | Las 8 consultas del enunciado, en SQL plano, cada una con la decisión no obvia comentada. |
| [`docs/EXPLAIN.md`](docs/EXPLAIN.md) | `EXPLAIN (ANALYZE, BUFFERS)` real de las consultas sobre 100.000 tickets. Es la respuesta medida a "¿y con millones de registros?". |
| [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) | Problemas ya diagnosticados y resueltos, con su causa. Consultar antes de depurar. |

## Uso de herramientas de IA

> Declaración exigida por el enunciado. **Pendiente de completar con los
> porcentajes reales antes de la entrega.**

- **Herramienta:** Claude Code (Opus).
- **Dónde se usó hasta ahora:** contraste de alternativas en el modelo de datos,
  redacción de la documentación y del `docker-compose`.
- **Dónde no:** las decisiones de arquitectura (enums vs catálogo, estrategia de
  invalidación de sesión, desnormalizaciones) son propias y están argumentadas
  una a una en `docs/DECISIONES-TECNICAS.md`.
- **Verificación:** la infraestructura no se dio por buena hasta levantarla:
  los tres fallos de entorno que aparecieron en el camino están en
  `docs/KNOWN_ISSUES.md` con su causa.

## Estado

- [x] Modelo entidad-relación y decisiones técnicas
- [x] Entorno Postgres (desarrollo + pruebas)
- [x] Esquema Prisma y migraciones — 11 tablas, 3 enums
- [x] Seed con volumen realista — 100.000 tickets y 659.000 filas de trazabilidad
- [x] `queries.sql` — las 8 consultas del enunciado, ejecutadas y medidas
- [x] Autenticación: sesiones rotativas, RFC 9457, CORS y rate limiting
- [ ] Módulo de tickets y CRUD de lectura
- [ ] Front React
