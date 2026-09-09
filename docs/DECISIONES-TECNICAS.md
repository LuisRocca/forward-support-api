# Decisiones técnicas — Plataforma de gestión de tickets de soporte

> Documento base para la sustentación. Cada decisión está escrita como
> **decisión → por qué → qué costo acepto → cuándo la cambiaría**.
> Una decisión que no puedo defender con esas cuatro líneas no entra al proyecto.

---

## 0. Lectura del enunciado

El PDF recibido llega **truncado**: los campos del ticket, la lista de estados y
prioridades, y varios ítems de las vistas del front aparecen como `• ...`.

Los anclajes duros y no negociables son las **7 consultas de `queries.sql`**: definen
qué preguntas tiene que poder responder el modelo. Diseñé el esquema *desde esas
consultas hacia atrás* — si una query necesita un dato que no existe o que solo se
puede obtener escaneando el historial completo, el modelo está mal.

Todo lo elidido lo propuse yo y está marcado como asunción explícita.

---

## 1. Modelo de datos

**11 tablas, 3 bloques:** identidad y acceso · operación · trazabilidad.

### Enums vs tablas de catálogo

| Concepto | Decisión | Razón |
|---|---|---|
| `ticket_status`, `ticket_priority`, `user_status` | **ENUM de Postgres** | Son parte del *flujo*: el código ramifica sobre ellos. Son pocos y estables. El tipo hace que la BD rechace un valor inválido, no solo el DTO. |
| `clients`, `ticket_categories`, `roles` | **Tabla** | Los administra el negocio y cambian sin deploy. |

**Costo que acepto:** agregar un estado nuevo exige `ALTER TYPE`. Es un cambio de
flujo de negocio, no de datos — quiero que duela un poco y pase por revisión.
**Cuándo lo cambio:** si el negocio pide configurar sus propios estados por área,
`ticket_status` pasa a tabla con máquina de estados en `status_transitions`.

### Estados y prioridades propuestos

- **Estados:** `open` → `in_progress` → `pending_customer` → `resolved` → `closed`.
  Reabrir **no** es un estado: devuelve el ticket a `open` e incrementa `reopened_count`.
  Un estado `reopened` sería redundante con el contador y ensucia todas las queries de "abiertos".
- **Prioridades:** `low`, `medium`, `high`, `critical` (la query 2 exige distinguir alta de crítica).

### Los tres campos que existen solo por las queries

Estos son los que conviene señalar en la sustentación, porque muestran que el modelo
se diseñó contra la consulta y no al revés:

1. **`tickets.last_activity_at`** — la query 3 pide "más de 48h sin actualización".
   `updated_at` **no cambia cuando alguien comenta**: usarlo daría tickets con actividad
   real marcados como estancados. `last_activity_at` se toca en cualquier evento del
   ticket (comentario, cambio de estado, reasignación) y lleva índice parcial
   `WHERE status <> 'closed'`.

2. **`tickets.reassignment_count`** — la query 7 (reasignados >2 veces) desde
   `ticket_assignments` es un `GROUP BY ... HAVING count(*) > 2` sobre el historial
   completo. Con millones de tickets eso es una agregación masiva por consulta.
   El contador desnormalizado la convierte en un index scan. Se actualiza en la
   **misma transacción** que inserta en `ticket_assignments` — sin transacción,
   la desnormalización es una mentira esperando a pasar.

3. **`tickets.resolved_by_user_id`** — la query 4 pide el usuario con más tickets
   resueltos. Usar `assigned_to_user_id` sería incorrecto: un ticket puede reasignarse
   *después* de resuelto, y el crédito se le daría al agente equivocado.

### Historial: dos tablas explícitas, no un `events` genérico

`ticket_status_history` y `ticket_assignments` en vez de una tabla `ticket_events`
con `type` + `payload JSONB`.

**Por qué:** las queries 4 y 7 salen tipadas, indexadas y legibles. Con JSONB serían
`payload->>'to_user_id'` sin integridad referencial.
**Costo:** una tabla nueva por cada tipo de evento auditable del ticket.
**Cuándo lo cambio:** si aparecen 5+ tipos de evento de baja consulta, esos van a
`audit_logs` (que ya es genérico con JSONB) y las dos tablas tipadas se quedan solo
para lo que se consulta de verdad.

Ambas son **append-only**: sin `UPDATE` ni `DELETE`. Un historial editable no es historial.

### Roles: N:M

`users` ←→ `user_roles` ←→ `roles`.

**Por qué N:M y no un enum en `users`:** en operación real un líder también atiende
tickets. Con 1:N habría que duplicar usuarios o inventar un rol `supervisor_agente`,
que es exactamente el tipo de deuda que se multiplica.

**Los permisos viven en código**, no en BD: un mapa `rol → permisos` versionado con la
app. Hoy son estáticos, y en código son testeables y revisables en el PR.
**Cuándo lo cambio:** cuando el negocio pida permisos configurables por UI aparece
`role_permissions`. Regla de tres — no antes.

### Convenciones

- **PK `UUIDv7`** en entidades de negocio: ordenado por tiempo, así mantiene localidad
  en el B-tree (el problema clásico de UUIDv4 son los page splits) y **no filtra volumen
  de negocio** — un `serial` en la URL le dice a cualquiera cuántos tickets tienes y
  habilita enumeración (IDOR).
  **Excepción:** `audit_logs` usa `BIGINT` autoincremental — append-only masivo, se
  particiona por mes y nadie referencia esas filas desde fuera.
- **`tickets.code`** (`TCK-000123`) es el identificador *humano*: el que se dice por
  teléfono. El UUID nunca se lee en voz alta.
- `TIMESTAMPTZ` siempre, nunca `TIMESTAMP`.
- Soft delete (`deleted_at`) donde hay historial que preservar; borrado físico en `refresh_tokens`.
- `snake_case` en BD, `camelCase` en la API — el ORM traduce.

---

## 2. Administración de usuarios: qué pasa cuando bloqueo a alguien

Esta es la pregunta trampa del proceso, porque con JWT la respuesta ingenua
("le pongo `active = false`") **no funciona**: el token ya emitido sigue siendo
válido hasta que expire. El atacante sigue dentro.

La respuesta está en el modelo — `users.token_version` y `refresh_tokens`:

1. `status = 'blocked'` + `blocked_at` / `blocked_by_user_id` / `blocked_reason` (quién y por qué, auditable).
2. **`token_version++`**. El access token lleva esa versión en el claim. En cada request
   el guard compara la versión del token contra la del usuario; si no coinciden, 401.
3. `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = X` → no puede renovar.
4. Access token de **15 minutos**: ventana máxima de exposición si algo del resto falla.
5. Queda registro en `audit_logs` (`action = 'user.blocked'`).

**El trade-off honesto:** el paso 2 exige conocer `token_version` en cada request. Sin
caché, es un `SELECT` por request y pierdo buena parte de la ventaja del JWT stateless.
La versión va en **Redis** (`user:{id}:tv`, TTL corto), no en Postgres. Sin Redis en el
entorno de la prueba, el fallback aceptable es apoyarse solo en el TTL de 15 min y
documentar la ventana.

**Además:** `failed_login_attempts` + `locked_until` para bloqueo automático por fuerza
bruta — deliberadamente **separado** de `status = 'blocked'`, que es administrativo.
Mezclarlos significa que un ataque de fuerza bruta contra un admin lo bloquea
administrativamente y hace falta otro admin para restaurarlo. Son dos problemas distintos.

---

## 3. Seguridad

| Riesgo | Medida en el modelo / la app |
|---|---|
| Robo de la BD | `password_hash` con **argon2id**; `refresh_tokens.token_hash` guarda SHA-256, nunca el token plano |
| Robo de refresh token | Rotación con `family_id`: si se reusa un token ya rotado, se revoca la familia completa (reuse detection) |
| Enumeración de recursos (IDOR) | UUID en las URLs; y **autorización por recurso**, no solo por rol: el agente solo actualiza tickets donde `assigned_to_user_id = req.user.id`. Verificar el rol y no la pertenencia es el bug de autorización más común |
| Fuerza bruta | `failed_login_attempts` + `locked_until` + rate limiting en `/auth/*` |
| Fuga de datos internos | `ticket_comments.is_internal` se filtra **en la query**, nunca en el front — mandar el comentario interno al navegador y ocultarlo con CSS es una filtración |
| SQL injection | Queries parametrizadas vía ORM; los filtros de ordenamiento van contra una allowlist de columnas |
| Trazabilidad | `audit_logs` con actor, IP, user-agent y `metadata` — con la regla explícita de **no** guardar ahí tokens ni passwords |
| Secrets | Solo por env / secret manager. `DATABASE_URL` y `JWT_SECRET` jamás en el repo |

Nota de alcance: **no hay multi-tenant**. La app es interna; los `clients` son *datos*,
no inquilinos. Decirlo explícitamente evita que alguien asuma aislamiento que no existe.

---

## 4. Grandes volúmenes

- **Paginación por keyset** `(created_at, id)`, nunca `OFFSET`. Con `OFFSET 100000`
  Postgres lee y descarta 100.000 filas: la página 10.000 cuesta 10.000 veces la primera.
  Con keyset, todas cuestan lo mismo. Índice `idx_tickets_created_at_id` dedicado.
- **Índices compuestos que siguen los filtros reales de la UI**, no uno por columna:
  `(status, priority)`, `(client_id, status)`, `(assigned_to_user_id, status)`.
- **Índice parcial** en `last_activity_at` `WHERE status <> 'closed' AND deleted_at IS NULL`:
  los cerrados son la mayoría del volumen histórico y nunca se consultan por antigüedad.
- **Métricas del dashboard desde vista materializada** refrescada cada N minutos.
  Un `COUNT(*)` por tarjeta en cada carga del dashboard es el primer sitio donde
  esto se cae con volumen.
- **`audit_logs` particionado por mes**, con retención — es la tabla que crece sin límite.
- **Sin N+1:** el listado de tickets trae cliente y agente con `JOIN` en una consulta.
- **Coste de API:** `Cache-Control` + `ETag` en catálogos, respuestas con selección de
  campos (el listado no devuelve `description` completo), y compresión. La query 3 y las
  métricas se sirven cacheadas: son las más caras y las que menos necesitan estar al segundo.

---

## 5. Pendientes de esta fase

- [ ] `docker-compose.yml` (Postgres local + entorno de pruebas aislado)
- [ ] `queries.sql` con las 7 consultas
- [ ] Esquema Prisma derivado de este modelo + seeds
- [ ] API NestJS (validación en el borde, filtro de excepciones centralizado, respuestas consistentes)
- [ ] Front React
- [ ] `README.md` con la declaración de uso de IA que pide el enunciado
