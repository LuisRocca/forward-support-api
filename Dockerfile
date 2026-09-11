# syntax=docker/dockerfile:1
#
# Imagen de producción de la API. Multi-etapa: se compila con las dependencias
# de desarrollo y la imagen final solo lleva dist + dependencias de producción.
#
# Sin secretos: DATABASE_URL, JWT_ACCESS_SECRET, CORS_ORIGIN y el resto entran
# por variables de entorno en tiempo de ejecución (en AWS, desde Secrets
# Manager en la task definition de ECS). La imagen es la misma en todos los
# entornos.
#
#   docker build --format docker -t forward-api .           (imagen de la API)
#   docker build --format docker --target migrate -t forward-api-migrate .
#
# --format docker hace falta con podman: en formato OCI se ignora HEALTHCHECK.

# Nombre completo con registro: podman no resuelve nombres cortos y, además,
# así no hay ambigüedad sobre de qué registro sale la imagen base.
ARG NODE_IMAGE=docker.io/library/node:24-alpine

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
# pnpm 11 pide confirmación interactiva al purgar node_modules si no ve CI.
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /app

# ------------------------------------------------- dependencias completas
FROM base AS deps
# pnpm-workspace.yaml trae la lista de scripts de instalación permitidos
# (argon2, prisma); sin él, argon2 no prepararía su módulo nativo.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ----------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# prisma.config.ts exige DATABASE_URL al cargarse, pero `generate` no se conecta
# a nada: basta un valor ficticio. No es un secreto y no llega a la imagen final.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build node_modules/.bin/prisma generate \
 && pnpm build

# ------------------------------------------- dependencias de producción
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Sobrepeso conocido (~200 MB de 539): @prisma/client declara `prisma` y
# `typescript` como peers opcionales, el lockfile los resuelve contra las
# devDependencies y --prod instala ese snapshot tal cual, con el CLI de prisma,
# Studio y los motores. No se usan en runtime. Probado sin éxito: quitar
# autoInstallPeers, quitar devDependencies antes de instalar y un override "-".
# Detalle y opciones en docs/KNOWN_ISSUES.md.
RUN pnpm install --prod --frozen-lockfile

# ------------------------------------------------------------- migrate
# Imagen para una tarea puntual de ECS que aplica las migraciones antes de
# desplegar la API. La imagen de la API no lleva el CLI de prisma: no le hace
# falta para arrancar y es superficie de ataque que no necesita.
# Sale de `build` y no de `deps` porque el seed importa el cliente generado:
# la misma imagen sirve para `prisma db seed` cambiando el comando.
FROM build AS migrate
COPY --chown=node:node certs ./certs
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# --------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Para /docs si se activa con DOCS_ENABLED=true; por defecto está apagada en
# producción.
COPY --chown=node:node docs/api-contract.yaml ./docs/api-contract.yaml
# CA de RDS: la conexión a la base verifica el certificado del servidor
# (sslmode=verify-full) en vez de aceptar cualquiera.
COPY --chown=node:node certs ./certs

# Sin root: si alguien consigue ejecutar código en el proceso, no es root del
# contenedor.
USER node
EXPOSE 3000

# Con node y fetch nativo, sin instalar curl ni wget en la imagen.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + (process.env.API_PREFIX ? '/' + process.env.API_PREFIX : '') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
