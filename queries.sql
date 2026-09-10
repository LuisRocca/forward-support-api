-- =============================================================================
--  Las 8 consultas del enunciado
--  Plataforma de gestión de tickets de soporte — PostgreSQL 18
-- =============================================================================
--
--  SQL plano y no Prisma a propósito: el enunciado pide las consultas, y en SQL
--  se ve el plan de ejecución, que es de lo que hay que responder cuando la
--  pregunta es "y con millones de registros".
--
--  Ejecutar contra la base de desarrollo:  pnpm db:psql -f queries.sql
--  Medidas reales sobre 100.000 tickets en docs/EXPLAIN.md
--
--  Dos criterios transversales:
--   - `deleted_at IS NULL` en todas: el soft delete no es opcional al contar.
--   - Los conteos por cliente y por agente usan LEFT JOIN, de forma que un
--     cliente sin tickets o un agente con la bandeja vacía aparecen con 0 y no
--     desaparecen del informe. Un informe que oculta los ceros miente.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Cantidad de tickets por estado para cada cliente.
-- -----------------------------------------------------------------------------
-- Pivotada con FILTER en vez de devolver (cliente, estado, n): el consumidor es
-- una tabla de dashboard con una columna por estado, y así sale en UNA pasada
-- sobre tickets en lugar de cinco conteos o un GROUP BY que el front tiene que
-- recomponer. Los cinco estados son un enum estable: la forma fija es correcta.
SELECT
  c.id                                                            AS cliente_id,
  c.name                                                          AS cliente,
  count(t.id)                                                     AS total,
  count(t.id) FILTER (WHERE t.status = 'open')                     AS abiertos,
  count(t.id) FILTER (WHERE t.status = 'in_progress')              AS en_curso,
  count(t.id) FILTER (WHERE t.status = 'pending_customer')         AS esperando_cliente,
  count(t.id) FILTER (WHERE t.status = 'resolved')                 AS resueltos,
  count(t.id) FILTER (WHERE t.status = 'closed')                   AS cerrados
FROM clients c
LEFT JOIN tickets t
       ON t.client_id = c.id
      AND t.deleted_at IS NULL
WHERE c.deleted_at IS NULL
GROUP BY c.id, c.name
ORDER BY total DESC, c.name;


-- -----------------------------------------------------------------------------
-- 2. Los cinco clientes con más tickets de prioridad alta o crítica.
-- -----------------------------------------------------------------------------
-- `priority IN ('high','critical')` y no `>= 'high'`: el orden de un enum de
-- Postgres es el de declaración, así que comparar con >= funciona hoy y se
-- rompe el día que alguien inserte un valor en medio con ALTER TYPE ... BEFORE.
-- El IN es explícito y no depende de ese orden.
--
-- Aquí el JOIN va al revés que en la 1 (INNER, desde tickets): se piden los
-- cinco de más carga, y un cliente con 0 no compite por entrar en el top.
SELECT
  c.id                                                        AS cliente_id,
  c.name                                                      AS cliente,
  count(*)                                                    AS tickets_prioritarios,
  count(*) FILTER (WHERE t.priority = 'critical')              AS criticos,
  count(*) FILTER (WHERE t.priority = 'high')                  AS altos
FROM tickets t
JOIN clients c ON c.id = t.client_id
WHERE t.priority IN ('high', 'critical')
  AND t.deleted_at IS NULL
GROUP BY c.id, c.name
ORDER BY tickets_prioritarios DESC, c.name
LIMIT 5;


-- -----------------------------------------------------------------------------
-- 3. Tickets con más de 48 horas sin actualización y que no están cerrados.
-- -----------------------------------------------------------------------------
-- LA DECISIÓN: se filtra por `last_activity_at`, NO por `updated_at`.
-- `updated_at` solo cambia cuando se modifica un campo del ticket: un ticket con
-- tres comentarios de hoy tiene el `updated_at` de la semana pasada y saldría
-- listado como estancado siendo falso. `last_activity_at` se toca en cualquier
-- evento del ticket (comentario, cambio de estado, reasignación).
--
-- El WHERE está escrito para calzar exactamente con el índice parcial
-- idx_tickets_stale (last_activity_at) WHERE status <> 'closed' AND deleted_at IS NULL.
-- Los cerrados son ~55% del volumen histórico y nunca se consultan por
-- antigüedad, así que no se indexan: el índice ocupa la mitad y cabe en caché.
--
-- 'resolved' NO se excluye: un ticket resuelto sin confirmar sigue siendo trabajo
-- pendiente de cierre. Si el negocio pide solo lo que está en curso, se añade
-- `AND t.status IN ('open','in_progress','pending_customer')`, que el mismo
-- índice sigue sirviendo.
SELECT
  t.code,
  t.title,
  t.status,
  t.priority,
  c.name                                                      AS cliente,
  u.full_name                                                  AS agente,
  t.last_activity_at,
  date_trunc('minute', now() - t.last_activity_at)             AS sin_actividad
FROM tickets t
JOIN clients c        ON c.id = t.client_id
LEFT JOIN users u     ON u.id = t.assigned_to_user_id
WHERE t.status <> 'closed'
  AND t.deleted_at IS NULL
  AND t.last_activity_at < now() - interval '48 hours'
ORDER BY t.last_activity_at
LIMIT 100;   -- listado paginado: nunca se devuelve el conjunto completo


-- -----------------------------------------------------------------------------
-- 4. Usuario con más tickets resueltos durante el último mes.
-- -----------------------------------------------------------------------------
-- LA DECISIÓN: se agrupa por `resolved_by_user_id`, NO por `assigned_to_user_id`.
-- Un ticket puede reasignarse DESPUÉS de resuelto (en los datos de prueba pasa
-- en un 15% de los casos): agrupar por el asignado actual le da el crédito al
-- agente equivocado. Por eso `resolved_by_user_id` existe como columna propia.
--
-- RANK() y no LIMIT 1: si dos agentes empatan, LIMIT 1 elige uno en silencio
-- según el orden físico de las filas. Con RANK salen los dos y el empate se ve.
--
-- "Último mes" = los últimos 30 días corridos. Si el informe tiene que cuadrar
-- con el cierre mensual, la ventana es
--   resolved_at >= date_trunc('month', now()) - interval '1 month'
--   AND resolved_at < date_trunc('month', now())
WITH resueltos AS (
  SELECT
    t.resolved_by_user_id                                      AS user_id,
    count(*)                                                   AS tickets_resueltos,
    round(avg(extract(epoch FROM (t.resolved_at - t.created_at)) / 3600), 1) AS horas_promedio
  FROM tickets t
  WHERE t.resolved_by_user_id IS NOT NULL
    AND t.deleted_at IS NULL
    AND t.resolved_at >= now() - interval '1 month'
  GROUP BY t.resolved_by_user_id
), posiciones AS (
  -- La ventana va en su propio nivel: una función de ventana no puede
  -- evaluarse en el WHERE, porque se calcula después de filtrar.
  SELECT r.*, rank() OVER (ORDER BY r.tickets_resueltos DESC) AS posicion
  FROM resueltos r
)
SELECT
  u.full_name                                                  AS agente,
  u.email,
  p.tickets_resueltos,
  p.horas_promedio
FROM posiciones p
JOIN users u ON u.id = p.user_id
WHERE p.posicion = 1
ORDER BY u.full_name;


-- -----------------------------------------------------------------------------
-- 5. Tiempo promedio de resolución por prioridad.
-- -----------------------------------------------------------------------------
-- El promedio se mide de `created_at` a `resolved_at`, no a `closed_at`: el
-- cierre depende de que el cliente confirme, que es tiempo que no gestiona el
-- equipo. Mezclarlos convierte el KPI del equipo en un KPI de la paciencia del
-- cliente.
--
-- Se incluye la mediana (percentile_cont) además del promedio porque un solo
-- ticket olvidado tres meses desplaza el AVG y hace parecer que el SLA se
-- incumple. La mediana es la que se defiende en una reunión.
SELECT
  t.priority                                                   AS prioridad,
  count(*)                                                     AS resueltos,
  justify_interval(avg(t.resolved_at - t.created_at))           AS promedio,
  round(avg(extract(epoch FROM (t.resolved_at - t.created_at)) / 3600), 1) AS horas_promedio,
  round((percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM (t.resolved_at - t.created_at))
        ) / 3600)::numeric, 1)                                  AS horas_mediana,
  round((percentile_cont(0.95) WITHIN GROUP (
          ORDER BY extract(epoch FROM (t.resolved_at - t.created_at))
        ) / 3600)::numeric, 1)                                  AS horas_p95
FROM tickets t
WHERE t.resolved_at IS NOT NULL
  AND t.deleted_at IS NULL
GROUP BY t.priority
ORDER BY horas_promedio;


-- -----------------------------------------------------------------------------
-- 6. Cantidad de tickets abiertos por agente.
-- -----------------------------------------------------------------------------
-- "Abierto" se define como trabajo aún en la bandeja del agente:
-- open | in_progress | pending_customer. `resolved` queda fuera porque el
-- trabajo ya está hecho y solo falta el cierre formal; si se contara, un agente
-- eficiente parecería sobrecargado.
--
-- LEFT JOIN desde users: un agente con la bandeja vacía tiene que aparecer con 0.
-- Es un informe de carga de trabajo y el 0 es justo el dato que se busca.
-- El filtro por rol viene de user_roles (N:M): un supervisor que también atiende
-- tickets aparece aquí, que es la razón de que los roles no sean un enum.
SELECT
  u.full_name                                                  AS agente,
  u.email,
  count(t.id)                                                  AS abiertos,
  count(t.id) FILTER (WHERE t.priority IN ('high', 'critical')) AS prioritarios,
  count(t.id) FILTER (WHERE t.due_at < now())                   AS vencidos
FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r       ON r.id = ur.role_id AND r.code = 'agent'
LEFT JOIN tickets t
       ON t.assigned_to_user_id = u.id
      AND t.status IN ('open', 'in_progress', 'pending_customer')
      AND t.deleted_at IS NULL
WHERE u.deleted_at IS NULL
  AND u.status = 'active'
GROUP BY u.id, u.full_name, u.email
ORDER BY abiertos DESC, u.full_name;


-- -----------------------------------------------------------------------------
-- 7. Tickets que han sido reasignados más de dos veces.
-- -----------------------------------------------------------------------------
-- LA DECISIÓN: se lee el contador desnormalizado `tickets.reassignment_count`,
-- no se agrega sobre `ticket_assignments`.
--
-- La versión "honesta" sería
--     SELECT ticket_id FROM ticket_assignments
--     WHERE from_user_id IS NOT NULL
--     GROUP BY ticket_id HAVING count(*) > 2
-- y es correcta, pero obliga a recorrer y agrupar el historial COMPLETO en cada
-- ejecución: con millones de tickets son millones de filas agregadas para
-- devolver unos pocos miles. El contador lo convierte en un filtro directo
-- sobre tickets. Se actualiza en la MISMA transacción que inserta en
-- ticket_assignments — si no, la desnormalización es una mentira esperando.
--
-- `reassignment_count` cuenta reasignaciones, no asignaciones: la primera
-- asignación (from_user_id IS NULL) no cuenta. Ambas formas dan el mismo
-- resultado; la consulta de verificación está en docs/EXPLAIN.md.
SELECT
  t.code,
  t.title,
  t.status,
  t.priority,
  c.name                                                       AS cliente,
  u.full_name                                                  AS agente_actual,
  t.reassignment_count                                         AS reasignaciones,
  t.created_at
FROM tickets t
JOIN clients c    ON c.id = t.client_id
LEFT JOIN users u ON u.id = t.assigned_to_user_id
WHERE t.reassignment_count > 2
  AND t.deleted_at IS NULL
ORDER BY t.reassignment_count DESC, t.created_at DESC
LIMIT 100;


-- -----------------------------------------------------------------------------
-- 8. Porcentaje de tickets cerrados frente al total de creados en los últimos
--    30 días.
-- -----------------------------------------------------------------------------
-- LA DECISIÓN: lectura por COHORTE. Denominador: tickets creados en la ventana.
-- Numerador: cuántos de ESOS mismos tickets están hoy cerrados. Así el
-- porcentaje nunca pasa de 100 y responde algo concreto: "de lo que entró este
-- mes, qué parte ya se cerró".
--
-- La otra lectura, la de FLUJO, divide los cerrados DURANTE la ventana
-- (closed_at en los 30 días, de cualquier fecha de creación) entre los creados
-- en la ventana. Mide si el equipo cierra al ritmo que entra trabajo, pero
-- mezcla poblaciones distintas y puede superar el 100% cuando se liquida
-- atraso. Sobre los datos de prueba: cohorte 53,1% (2.935 de 5.525), flujo
-- 60,9% (3.365 cerrados en la ventana). Si el negocio pregunta por capacidad
-- del equipo, es la de flujo:
--     count(*) FILTER (WHERE closed_at >= now() - interval '30 days')
--
-- Ventana vacía: NULLIF convierte la división por cero en NULL. Es la respuesta
-- honesta —"no hay datos"—; un 0% diría que no se cerró nada de lo que entró.
SELECT
  count(*)                                                     AS creados,
  count(*) FILTER (WHERE t.status = 'closed')                  AS cerrados,
  round(100.0 * count(*) FILTER (WHERE t.status = 'closed')
        / NULLIF(count(*), 0), 1)                              AS porcentaje_cerrados
FROM tickets t
WHERE t.created_at >= now() - interval '30 days'
  AND t.deleted_at IS NULL;
