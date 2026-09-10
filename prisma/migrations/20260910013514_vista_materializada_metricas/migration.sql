-- Métricas del dashboard desde una vista materializada.
--
-- El motivo está medido: las cuatro consultas del dashboard son agregaciones
-- GLOBALES —cuentan todos los tickets que cumplen un filtro— y por definición
-- tienen que leer la tabla entera. Ningún índice arregla eso. Sobre 100.000
-- tickets la más cara son 57 ms; un COUNT(*) por tarjeta en cada carga del
-- dashboard es el primer sitio donde esto se cae con volumen.
--
-- Lo que sí lo arregla es no ejecutarlas en cada carga. La vista se refresca
-- cada N minutos y `generated_at` dice de cuándo son los datos, para que el
-- front lo muestre en vez de aparentar tiempo real.
--
-- now() queda congelado en el momento del refresco, que es justo la semántica
-- que se quiere: "tickets estancados a fecha de generated_at".

CREATE MATERIALIZED VIEW dashboard_metrics AS
WITH vivos AS (
  SELECT * FROM tickets WHERE deleted_at IS NULL
), abiertos AS (
  -- Definición única de "abierto" del contrato: open, in_progress y
  -- pending_customer. Un resuelto espera cierre y no requiere acción de nadie.
  -- Estancados y sin asignar salen de ESTE conjunto, así que por construcción
  -- nunca pueden superar a los abiertos.
  SELECT * FROM vivos WHERE status IN ('open', 'in_progress', 'pending_customer')
)
SELECT
  1 AS id,
  now() AS generated_at,

  (SELECT count(*) FROM abiertos) AS open_tickets,

  -- Abiertos sin actividad —de cualquier tipo, comentarios incluidos— en más
  -- de 48h. Difiere a propósito de la consulta 3 de queries.sql, que sigue
  -- literal el enunciado ("no cerrados") e incluye los resueltos.
  (SELECT count(*) FROM abiertos
    WHERE last_activity_at < now() - interval '48 hours') AS stale_tickets,

  (SELECT count(*) FROM abiertos
    WHERE assigned_to_user_id IS NULL) AS unassigned_tickets,

  (SELECT count(*) FROM vivos
    WHERE resolved_at >= now() - interval '7 days') AS resolved_last_7_days,

  (SELECT coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', n) ORDER BY status), '[]'::jsonb)
     FROM (SELECT status, count(*) AS n FROM vivos GROUP BY status) AS s) AS by_status,

  (SELECT coalesce(jsonb_agg(jsonb_build_object('priority', priority, 'count', n) ORDER BY priority), '[]'::jsonb)
     FROM (SELECT priority, count(*) AS n FROM vivos GROUP BY priority) AS p) AS by_priority,

  -- De created_at a resolved_at, no a closed_at: el cierre depende de que el
  -- cliente confirme, que es tiempo que el equipo no gestiona.
  (SELECT coalesce(jsonb_agg(jsonb_build_object('priority', priority, 'hours', horas) ORDER BY priority), '[]'::jsonb)
     FROM (
       SELECT priority,
              round(avg(extract(epoch FROM (resolved_at - created_at)) / 3600)::numeric, 1) AS horas
       FROM vivos WHERE resolved_at IS NOT NULL GROUP BY priority
     ) AS a) AS avg_resolution_hours_by_priority;

-- Índice único obligatorio para poder usar REFRESH ... CONCURRENTLY, que es lo
-- que permite refrescar sin bloquear las lecturas del dashboard.
CREATE UNIQUE INDEX dashboard_metrics_pkey ON dashboard_metrics (id);
