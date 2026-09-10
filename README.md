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
| Lint / formato | oxlint · Prettier |
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

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/DECISIONES-TECNICAS.md`](docs/DECISIONES-TECNICAS.md) | Decisiones de arquitectura y modelo, cada una con su justificación, su costo asumido y las condiciones bajo las que la cambiaría. |
| [`docs/modelo-er-soporte.ddb`](docs/modelo-er-soporte.ddb) | Modelo entidad-relación. Se abre en [drawdb.app](https://drawdb.app) con *File → Import diagram*. |
| [`queries.sql`](queries.sql) | Las 7 consultas del enunciado, en SQL plano, cada una con la decisión no obvia comentada. |
| [`docs/EXPLAIN.md`](docs/EXPLAIN.md) | `EXPLAIN (ANALYZE, BUFFERS)` real de las 7 consultas sobre 100.000 tickets. Es la respuesta medida a "¿y con millones de registros?". |
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
- [x] `queries.sql` — las 7 consultas del enunciado, ejecutadas y medidas
- [ ] Autenticación y autorización por rol
- [ ] Módulo de tickets
