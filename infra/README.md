# Infraestructura AWS (CDK)

Variante mínima de demo del diseño de
[`docs/DECISIONES-TECNICAS.md` §9](../docs/DECISIONES-TECNICAS.md#9-despliegue-en-aws):
CloudFront (front en S3 + API en `/api/*`), ALB interno, una tarea Fargate y
RDS PostgreSQL 18 `t4g.micro`, en `us-east-1`.

**No está desplegada.** Coste si se despliega: ~35–45 USD/mes.

## Requisitos

- Node 24 y pnpm.
- Docker o Podman (`CDK_DOCKER=podman` si no hay un `docker` en el PATH).
- `erp_forward` clonado junto a este repo (`../../erp_forward`): la síntesis
  compila el front con `VITE_API_URL=/api`.
- Credenciales de un usuario IAM (nunca root) configuradas con `aws configure`.

## Uso

```bash
pnpm install
pnpm synth              # genera la plantilla en cdk.out, sin credenciales
pnpm exec cdk bootstrap # una vez por cuenta y región
pnpm deploy             # ~15–20 min la primera vez (RDS y CloudFront)
pnpm task:migrate       # aplica las migraciones y sale con su código
pnpm task:seed          # datos de prueba (100.000 tickets por defecto)
pnpm destroy            # borra todo salvo un snapshot final de RDS
```

La URL sale en el output `Url` del stack. La contraseña de las cuentas de
prueba se genera en Secrets Manager:

```bash
aws secretsmanager get-secret-value --secret-id <output SeedPasswordSecret> \
  --query SecretString --output text
```

## Qué verificar tras el primer despliegue

1. `GET <Url>/api/health` → `{"status":"ok","database":"up"}`: la API conecta
   con RDS por TLS verificado.
2. `pnpm task:migrate` sale con 0: el motor de migraciones también verifica TLS.
3. Login, recargar la página y seguir dentro: la cookie de refresh
   (`Path=/api/auth`, `SameSite=Strict`) viaja por CloudFront.
4. La IP guardada en `refresh_tokens` es la del cliente, no una de CloudFront
   (`TRUST_PROXY_HOPS=2`).
