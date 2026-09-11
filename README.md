# Plataforma de Soporte — API

[![CI](https://github.com/LuisRocca/forward-support-api/actions/workflows/ci.yml/badge.svg)](https://github.com/LuisRocca/forward-support-api/actions/workflows/ci.yml)

API REST para la gestión de tickets de soporte: registrar, consultar, asignar y
dar seguimiento, con trazabilidad completa y control de acceso por rol.

> Prueba técnica · Tech Lead Full Stack JavaScript.
> El frontend vive en un repositorio aparte ([forward-support-web](https://github.com/LuisRocca/forward-support-web)) y consume esta API a
> través de un contrato OpenAPI compartido.

**Lo esencial en 30 segundos**

- **8 consultas del enunciado** resueltas en SQL plano y **medidas** sobre 100.000
  tickets: las dos que dan miedo por volumen (estancados y reasignados) responden
  en menos de 1 ms. → [`queries.sql`](queries.sql) · [`docs/EXPLAIN.md`](docs/EXPLAIN.md)
- **Bloqueo de usuario inmediato**, no "cuando caduque el token": versión de
  token comprobada en cada petición y sesiones rotativas con detección de robo.
- **Autorización por rol y por pertenencia**: un agente no ve ni toca tickets
  ajenos, y el servidor responde 404 (no 403) para no confirmar que existen.
- **Contrato primero**: la API se construyó contra `docs/api-contract.yaml`, el
  mismo fichero contra el que construye el front y el que sirve Swagger.
- **55 tests unitarios + 27 e2e**, validados con mutaciones: se comprobó que
  fallan cuando se rompe la regla que cubren.

---

## Contenido

1. [Stack](#stack)
2. [Arquitectura](#arquitectura)
3. [Puesta en marcha](#puesta-en-marcha)
4. [Configuración](#configuración)
5. [Cuentas de prueba](#cuentas-de-prueba)
6. [API](#api)
7. [Roles y permisos](#roles-y-permisos)
8. [Datos y rendimiento](#datos-y-rendimiento)
9. [Calidad](#calidad)
10. [Contenedor y despliegue](#contenedor-y-despliegue)
11. [Estructura del repositorio](#estructura-del-repositorio)
12. [Documentación](#documentación)
13. [Uso de herramientas de IA](#uso-de-herramientas-de-ia)
14. [Estado](#estado)

---

## Stack

| Capa | Elección |
|---|---|
| Runtime | Node.js 24 |
| Framework | NestJS 12 · TypeScript en modo `strict` |
| Base de datos | PostgreSQL 18 (`citext`, `pg_trgm`, `uuidv7()` nativo) |
| ORM / migraciones | Prisma 7 con driver adapter `pg` |
| Autenticación | JWT de acceso + refresh opaco en cookie `httpOnly` · argon2id |
| Tests | Vitest (unitarios y e2e con Supertest) |
| Calidad | oxlint `--type-aware` · Prettier · SonarQube |
| Contenedores | Docker/Podman multi-etapa · Docker Compose para la infraestructura local |
| Infraestructura | AWS CDK (TypeScript): CloudFront, ALB, ECS Fargate, RDS, Secrets Manager |
| Paquetes | pnpm |

## Arquitectura

Monolito modular en NestJS, sin estado (la sesión vive en base de datos), con
PostgreSQL como única fuente de verdad. Cada petición atraviesa una cadena fija:

```
traza → rate limiting → autenticación → permisos por rol → validación → controlador → servicio (pertenencia) → Prisma
                                        cualquier error ──────────────────────────────→ RFC 9457
```

El detalle —módulos, flujos de autenticación, máquina de estados, modelo de
datos, despliegue en AWS y los patrones aplicados— está en
**[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** (en inglés). El porqué de
cada decisión, en **[`docs/DECISIONES-TECNICAS.md`](docs/DECISIONES-TECNICAS.md)**.

## Puesta en marcha

**Requisitos:** Node.js 24, pnpm 11 y Docker o Podman.

```bash
pnpm install
cp .env.example .env          # definir JWT_ACCESS_SECRET y SEED_PASSWORD
pnpm db:up                    # Postgres de desarrollo y de pruebas
pnpm db:migrate               # aplica las migraciones
pnpm db:seed                  # ~100.000 tickets con distribución realista (~25 s)
pnpm start:dev                # API en http://localhost:3000, con hot reload
```

Documentación interactiva en **http://localhost:3000/docs**.

| Servicio | Puerto | Notas |
|---|---|---|
| API | 3000 | fuera del contenedor, con hot reload |
| Postgres desarrollo | **5442** | persistente en volumen |
| Postgres pruebas | **5443** | efímero, en RAM |
| Adminer | 8080 | opcional: `pnpm db:tools` |
| SonarQube | 9000 | opcional: `pnpm sonar:up` |

Los puertos 5442/5443 en vez de los habituales 5432/5433 son deliberados: una
máquina de desarrollo casi siempre tiene ya un Postgres local ocupándolos.

La base de pruebas vive en `tmpfs` con `fsync=off`: se pierde al parar el
contenedor, que es justo lo que se quiere de una base de pruebas, y la suite
corre mucho más rápido. La suite e2e la migra sola al arrancar.

## Configuración

Toda la configuración entra por variables de entorno. **Ningún secreto tiene
valor por defecto**: si falta, la aplicación no arranca, en vez de caer en
silencio a un valor conocido.

| Variable | Obligatoria | Uso |
|---|---|---|
| `DATABASE_URL` | sí | Conexión a PostgreSQL |
| `JWT_ACCESS_SECRET` | sí | Firma del access token (`openssl rand -base64 48`) |
| `CORS_ORIGIN` | sí | Orígenes permitidos, separados por comas. Nunca `*`: con credenciales, el navegador lo rechaza |
| `SEED_PASSWORD` | para el seed | Contraseña de las cuentas de prueba. Sin default a propósito |
| `DATABASE_URL_TEST` | para e2e | Base de pruebas; la suite se niega a correr si no acaba en `_test` |
| `PORT`, `NODE_ENV` | no | `3000`, `development` |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | no | `15m`, `7d` |
| `ARGON_MEMORY_COST` | no | Memoria de argon2id en KiB (`19456`) |
| `AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES` | no | Bloqueo por fuerza bruta (`5`, `15`) |
| `AUTH_RATE_LIMIT_LOGIN`, `AUTH_RATE_LIMIT_REFRESH` | no | Peticiones/min por IP en `/auth` (`5`, `30`) |
| `API_RATE_LIMIT` | no | Peticiones/min por IP en el resto (`600`) |
| `DOCS_ENABLED` | no | Swagger en `/docs`. Por defecto activo salvo en producción |

`JWT_REFRESH_SECRET` aparece en `.env.example` pero **no se usa**: el refresh
token es un valor opaco aleatorio, no un JWT.

## Cuentas de prueba

El seed activa tres cuentas **sobre usuarios que ya existen y ya tienen datos**,
en lugar de crear cuentas nuevas: un usuario recién creado entra y ve la bandeja
vacía, y esa prueba no demuestra nada.

| Rol | Email | Qué verás |
|---|---|---|
| Administrador | `admin@forward.test` | Todo |
| Supervisor | `supervisor1@forward.test` | Toda la operación, sin editar ni cambiar estados |
| Agente | el que imprime el seed | El agente con más carga real de los 100.000 tickets (~850 abiertos) |

La contraseña de las tres es tu `SEED_PASSWORD`. El resto de los 40 usuarios
**no pueden iniciar sesión**: en `password_hash` llevan un marcador, no un hash.
Guardar en el repositorio el hash de una contraseña conocida sería guardar una
credencial válida.

## API

Documentación interactiva: **`/docs`** (Swagger UI), generada desde
[`docs/api-contract.yaml`](docs/api-contract.yaml) tal cual. Para probar rutas
protegidas: `POST /auth/login` → copiar `accessToken` → botón **Authorize**.
En producción está apagada por defecto (`DOCS_ENABLED`): publicar la superficie
completa de la API es información gratis para quien mire.

| Área | Endpoints |
|---|---|
| Autenticación | `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` |
| Tickets | `GET /tickets` · `POST /tickets` · `GET /tickets/{id}` · `PATCH /tickets/{id}` |
| Flujo del ticket | `POST /tickets/{id}/status` · `POST /tickets/{id}/assign` · `GET /tickets/{id}/history` |
| Comentarios | `GET /tickets/{id}/comments` · `POST /tickets/{id}/comments` |
| Usuarios | `GET /users` · `POST /users/{id}/block` · `POST /users/{id}/unblock` |
| Catálogos | `GET /clients` · `GET /ticket-categories` |
| Métricas | `GET /metrics/dashboard` |
| Operación | `GET /health` |

**Convenciones:**

- **Paginación por keyset** (`limit` + `cursor` opaco), nunca por `OFFSET` y
  **sin total**: el `COUNT(*)` sobre el filtro es la consulta que se cae con
  millones de filas. Respuesta `{ data, pageInfo: { nextCursor, hasMore } }`.
- **Errores en RFC 9457** (`application/problem+json`) siempre, incluidos los
  500, con un `code` estable para el cliente y un `traceId` que correlaciona con
  el log del servidor.
- **Cambiar estado y asignar son endpoints propios**, no campos del `PATCH`:
  cada uno deja su rastro en el historial dentro de la misma transacción.
- El detalle del ticket incluye `allowedStatusTransitions`: los estados a los que
  **quien pregunta** puede moverlo. El front no replica la regla.

**Códigos que el cliente distingue:**

| HTTP | `code` | Significado |
|---|---|---|
| 401 | `AUTH_TOKEN_EXPIRED` | Renovar con `/auth/refresh` y reintentar una vez |
| 401 | `AUTH_TOKEN_REVOKED` · `AUTH_USER_BLOCKED` · `AUTH_TOKEN_INVALID` | No reintentar: cerrar sesión |
| 401 | `AUTH_INVALID_CREDENTIALS` | Login fallido, idéntico exista o no el email |
| 409 | `INVALID_STATUS_TRANSITION` | Transición no permitida desde el estado actual |
| 409 | `CONFLICT` | Otro usuario cambió el ticket entre lectura y escritura |
| 409 | `TICKET_CLOSED` | Editar o reasignar un cerrado; solo el admin reabre |
| 423 | `ACCOUNT_LOCKED` | Cuenta bloqueada por intentos fallidos o por un admin |
| 429 | `RATE_LIMITED` | Con cabecera `Retry-After` en segundos, expuesta por CORS |

## Roles y permisos

Matriz implementada y cubierta por tests e2e. Los 403 son de **rol**; los 404
son de **pertenencia**: un ticket ajeno "no existe" para el agente.

| Acción | Admin | Supervisor | Agente |
|---|:-:|:-:|:-:|
| Ver tickets | todos | todos | solo asignados |
| Crear ticket | ✓ | ✓ | ✓ (queda autoasignado) |
| Editar ticket | ✓ | — | solo asignados |
| Cambiar estado | ✓ | — | solo asignados |
| Cerrar / reabrir | ✓ | — | — |
| Asignar / reasignar | ✓ | ✓ | — |
| Comentar | ✓ | ✓ | solo asignados |
| Comentario interno | ✓ | ✓ | lee, no crea |
| Métricas del dashboard | ✓ | ✓ | — |
| Listar usuarios | ✓ | ✓ | — |
| Bloquear / desbloquear | ✓ | — | — |

Los roles son N:M: un supervisor que también atiende tickets recibe la unión de
permisos. Los permisos viven en código ([`src/auth/permissions.ts`](src/auth/permissions.ts)),
versionados y revisables en cada cambio.

## Datos y rendimiento

El modelo se diseñó **desde las consultas hacia atrás**: tres columnas existen
solo porque una consulta del enunciado las necesita
(`last_activity_at`, `reassignment_count`, `resolved_by_user_id`).

`pnpm db:seed` genera un volumen con distribución deliberada, no uniforme:
100.000 tickets y ~660.000 filas de trazabilidad (asignaciones, historial de
estados y comentarios), reproducible con `setseed`.

| Consulta | Plan | Tiempo |
|---|---|---|
| 3 · Estancados > 48 h | `Index Scan` sobre el índice parcial `idx_tickets_stale` | ~0,8 ms |
| 7 · Reasignados > 2 veces | `Index Scan` sobre `idx_tickets_reasignados`, sin `Sort` | ~0,9 ms |
| 1, 2, 5, 6 · Agregaciones globales | Leen la tabla por definición | 18–57 ms → vista materializada |

Los `EXPLAIN (ANALYZE, BUFFERS)` completos, y lo que se aprendió midiendo
(incluida una conclusión propia que hubo que corregir), están en
[`docs/EXPLAIN.md`](docs/EXPLAIN.md).

```bash
pnpm db:psql -f queries.sql     # ejecutar las 8 consultas
```

## Calidad

```bash
pnpm lint        # oxlint --type-aware sobre src/, test/ y prisma/
pnpm typecheck   # tsc sobre el proyecto entero
pnpm build       # compilación de producción
pnpm test        # 55 unitarios: máquina de estados, permisos, tokens, guard
pnpm test:e2e    # 27 e2e: contrato de errores y matriz de roles completa
pnpm test:cov    # cobertura lcov de unitarios y e2e
pnpm sonar:scan  # análisis en SonarQube (tras test:cov)
```

- **Los tests pueden fallar.** Se validaron con cinco mutaciones deliberadas
  (cerrar sin ser admin, no revocar sesiones robadas, ignorar la versión del
  token, dar edición al supervisor, dejar al agente ver tickets ajenos): las
  cinco se detectaron.
- **El lint tiene dientes**: corre con `--type-aware`, sin el cual
  `no-floating-promises` se acepta en la configuración pero no detecta nada.
- `lint` y `typecheck` no son redundantes con `build`: la compilación solo cubre
  `src/`.
- **CI en cada push y pull request** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):
  todo lo anterior salvo Sonar, con los e2e contra un PostgreSQL 18 efímero del
  propio workflow, más el chequeo de tipos de `infra/`. El secreto JWT se genera
  en cada ejecución: no hay ninguno guardado en el repo ni en GitHub.

## Contenedor y despliegue

```bash
docker build --format docker -t forward-api .                          # API
docker build --format docker --target migrate -t forward-api-migrate . # migraciones
```

| Propiedad | Cómo |
|---|---|
| Multi-etapa | Compila con dependencias de desarrollo; la imagen final lleva `dist` y dependencias de producción |
| Sin secretos | Todo por variables de entorno en ejecución; `.dockerignore` excluye `.env` |
| Sin root | Usuario `node` (uid 1000) |
| Healthcheck | `GET /health`: 200 si la base responde, 503 si no o si tarda más de 2 s |
| Cierre ordenado | Sale con `SIGTERM` en ~2 s, que es lo que manda ECS al desplegar |
| Migraciones | Imagen `migrate` para una tarea puntual antes de cada despliegue |

`--format docker` es necesario con Podman: en formato OCI se ignora el
`HEALTHCHECK`. La imagen pesa 539 MB, de los que ~200 MB son herramientas que
entran por una dependencia opcional de `@prisma/client`; causa y alternativas
en [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).

El despliegue objetivo es **AWS** (S3 + CloudFront, ALB + ECS Fargate, RDS,
Secrets Manager). Diseño y razones en
[`docs/DECISIONES-TECNICAS.md`](docs/DECISIONES-TECNICAS.md#9-despliegue-en-aws).
La infraestructura está escrita en CDK en [`infra/`](infra/README.md) y
sintetiza sin errores; no está desplegada.

Variables que solo importan detrás de proxies:

| Variable | Local | AWS (`infra/`) |
|---|---|---|
| `API_PREFIX` | vacío | `api`: front y API comparten dominio |
| `TRUST_PROXY_HOPS` | `1` | `2`: CloudFront + ALB |

## Estructura del repositorio

```
src/
├── auth/          login, refresh, sesiones, guards, mapa de permisos
├── tickets/       listado, detalle, escritura, estados, comentarios, historial
├── users/         listado y bloqueo de usuarios
├── catalog/       clientes y categorías
├── metrics/       dashboard desde vista materializada
├── health/        healthcheck para el balanceador
├── common/        errores RFC 9457, paginación keyset, rate limiting, traza
├── config/        variables de entorno, sin defaults para secretos
├── docs/          Swagger UI servida desde el contrato
└── prisma/        conexión a la base
prisma/            esquema, migraciones y seed
test/              e2e
docs/              contrato, decisiones, arquitectura, mediciones, incidencias
infra/             infraestructura AWS en CDK (proyecto aparte, sin desplegar)
certs/             CA pública de RDS para verificar TLS
queries.sql        las 8 consultas del enunciado
```

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Arquitectura del sistema: módulos, flujos, patrones y despliegue (en inglés) |
| [`docs/DECISIONES-TECNICAS.md`](docs/DECISIONES-TECNICAS.md) | Cada decisión con su justificación, su costo asumido y cuándo se cambiaría |
| [`docs/api-contract.yaml`](docs/api-contract.yaml) | Contrato OpenAPI 3.1 compartido con el front: la fuente de verdad de la API |
| [Diagrama entidad-relación](https://www.drawdb.app/editor?shareId=c7c2bb718cc409d8b5125b76deb767c6) | Modelo de datos en drawDB. También en [`docs/modelo-er-soporte.ddb`](docs/modelo-er-soporte.ddb) (*File → Import diagram*) |
| [`queries.sql`](queries.sql) | Las 8 consultas del enunciado, cada una con su decisión no obvia comentada |
| [`docs/EXPLAIN.md`](docs/EXPLAIN.md) | Planes de ejecución reales sobre 100.000 tickets |
| [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) | Problemas diagnosticados y resueltos, con su causa. Consultar antes de depurar |

## Uso de herramientas de IA

- **Herramienta:** Claude Code (Anthropic).
- **Dónde se usó:** implementación de la API y de los tests bajo dirección y
  revisión del autor, generación del volumen de datos, mediciones con `EXPLAIN`,
  infraestructura local y documentación.
- **Criterio propio:** las decisiones de modelo y arquitectura están argumentadas
  una a una en [`docs/DECISIONES-TECNICAS.md`](docs/DECISIONES-TECNICAS.md).
- **Verificación:** nada se dio por bueno sin ejecutarlo. Cada funcionalidad se
  probó contra la API corriendo, los tests se validaron con mutaciones y los
  fallos encontrados por el camino están documentados con su causa en
  [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).

## Estado

- [x] Modelo entidad-relación y decisiones técnicas
- [x] Infraestructura local: Postgres de desarrollo y de pruebas
- [x] Esquema, migraciones y seed de 100.000 tickets
- [x] Las 8 consultas del enunciado, ejecutadas y medidas
- [x] Autenticación con sesiones rotativas, bloqueo inmediato y rate limiting
- [x] Tickets completos: listado, detalle, alta, edición, estados, asignación, comentarios, historial
- [x] Usuarios: listado, bloqueo y desbloqueo
- [x] Métricas del dashboard desde vista materializada
- [x] Tests unitarios y e2e de la matriz de roles
- [x] Imagen Docker de producción, healthcheck y Swagger
- [ ] Análisis de SonarQube (configurado; el escaneo local falla por un problema de red de Podman)
- [ ] Despliegue en AWS
