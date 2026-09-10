-- Generación masiva de tickets y de su trazabilidad.
--
-- Va en SQL y no en el cliente de Prisma a propósito: son ~100.000 tickets más
-- su historial, y hacerlo fila por fila desde Node son cientos de miles de
-- viajes de ida y vuelta. Aquí es un puñado de INSERT ... SELECT.
--
-- El objetivo no es "tener datos": es que las 7 consultas de queries.sql
-- devuelvan resultados no triviales y que el EXPLAIN signifique algo. Por eso
-- la distribución es deliberada, no uniforme:
--   - los cerrados son la mayoría del volumen histórico (55%);
--   - lo crítico se resuelve antes que lo bajo (consulta 5 discrimina);
--   - una minoría de tickets se reasigna más de dos veces (consulta 7);
--   - una parte de los tickets vivos lleva más de 48h sin actividad (consulta 3).
--
-- setseed() lo hace reproducible: dos ejecuciones dan el mismo conjunto.
--
-- Las sentencias van separadas por la marca "-- >>>", que es lo que usa
-- prisma/seed.ts para trocear el archivo.

-- >>>
SELECT setseed(0.42);

-- >>>
TRUNCATE ticket_comments, ticket_status_history, ticket_assignments, tickets;

-- >>>
-- Tickets. Cada CTE deriva del anterior porque en un mismo SELECT no se puede
-- reutilizar una columna calculada.
WITH cli AS (
  SELECT array_agg(id ORDER BY id) AS ids, count(*)::int AS n FROM clients
), cat AS (
  SELECT array_agg(id ORDER BY id) AS ids, count(*)::int AS n FROM ticket_categories
), ag AS (
  SELECT array_agg(u.id ORDER BY u.id) AS ids, count(*)::int AS n
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN roles r ON r.id = ur.role_id
  WHERE r.code = 'agent'
), autor AS (
  SELECT array_agg(u.id ORDER BY u.id) AS ids, count(*)::int AS n
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN roles r ON r.id = ur.role_id
  WHERE r.code IN ('supervisor', 'admin')
), dado AS (
  SELECT i,
         random() AS r_estado,   random() AS r_prio,     random() AS r_edad,
         random() AS r_dur,      random() AS r_inactivo, random() AS r_reasig,
         random() AS r_asignado, random() AS r_resolutor, random() AS r_cliente,
         random() AS r_cat,      random() AS r_agente,   random() AS r_autor,
         random() AS r_reabierto, random() AS r_cierre
  FROM generate_series(1, current_setting('seed.tickets')::int) AS i
), base AS (
  SELECT d.*,
         -- El histórico está dominado por lo cerrado: es justo lo que el índice
         -- parcial idx_tickets_stale se ahorra indexar.
         CASE WHEN r_estado < 0.55 THEN 'closed'
              WHEN r_estado < 0.70 THEN 'resolved'
              WHEN r_estado < 0.82 THEN 'open'
              WHEN r_estado < 0.92 THEN 'in_progress'
              ELSE 'pending_customer' END::ticket_status AS estado_ideal,
         CASE WHEN r_prio < 0.25 THEN 'low'
              WHEN r_prio < 0.70 THEN 'medium'
              WHEN r_prio < 0.92 THEN 'high'
              ELSE 'critical' END::ticket_priority AS prioridad,
         now() - (r_edad * interval '540 days') AS creado
  FROM dado d
), tiempos AS (
  SELECT b.*,
         -- Horas hasta la resolución según prioridad. La dispersión (0,4x a 2x)
         -- evita que la consulta 5 dé promedios sospechosamente limpios.
         (CASE prioridad WHEN 'critical' THEN 4
                         WHEN 'high'     THEN 12
                         WHEN 'medium'   THEN 36
                         ELSE 72 END * (0.4 + r_dur * 1.6)) * interval '1 hour' AS duracion
  FROM base b
), estado AS (
  SELECT t.*,
         -- Un ticket recién creado no puede estar ya resuelto: si su duración no
         -- cabe hasta hoy, se queda en curso. Así resolved_at - created_at es
         -- siempre un tiempo de resolución real y no un artefacto del seed.
         CASE WHEN estado_ideal IN ('resolved', 'closed') AND creado + duracion > now()
              THEN 'in_progress'::ticket_status
              ELSE estado_ideal END AS est
  FROM tiempos t
), fechas AS (
  SELECT e.*,
         CASE WHEN est IN ('resolved', 'closed') THEN creado + duracion END AS resuelto
  FROM estado e
), cierre AS (
  SELECT f.*,
         CASE WHEN est = 'closed'
              THEN least(resuelto + (r_cierre * interval '5 days'), now())
         END AS cerrado,
         -- Solo lo que sigue abierto puede estar sin asignar (bandeja de entrada).
         CASE WHEN est = 'open' AND r_asignado < 0.25 THEN NULL
              ELSE (SELECT ids[1 + floor(r_agente * n)::int] FROM ag)
         END AS agente
  FROM fechas f
), actividad AS (
  SELECT c.*,
         -- CLAVE de la consulta 3. Para lo vivo, la última actividad se reparte
         -- sesgada hacia lo reciente (r^3): ~40% con actividad de menos de 48h y
         -- el resto estancado, que es lo que hace que la consulta 3 no sea trivial.
         CASE WHEN est = 'closed'   THEN cerrado
              WHEN est = 'resolved' THEN resuelto
              ELSE greatest(creado, now() - (power(r_inactivo, 3) * interval '30 days'))
         END AS ultima_actividad
  FROM cierre c
)
INSERT INTO tickets (
  code, client_id, category_id, title, description, status, priority,
  created_by_user_id, assigned_to_user_id, assigned_at, first_response_at,
  resolved_at, resolved_by_user_id, closed_at, reopened_count, reassignment_count,
  due_at, last_activity_at, created_at, updated_at
)
SELECT
  'TCK-' || lpad(a.i::text, 6, '0'),
  (SELECT ids[1 + floor(a.r_cliente * n)::int] FROM cli),
  -- 8% sin categoría: la clasifica el agente después, y la consulta tiene que
  -- aguantar el NULL.
  CASE WHEN a.r_cat < 0.92 THEN (SELECT ids[1 + floor(a.r_cat * n)::int] FROM cat) END,
  (ARRAY[
    'No puedo iniciar sesión en el portal',
    'Error 500 al guardar el formulario',
    'La factura no refleja el último pago',
    'Solicitud de alta de usuario nuevo',
    'El informe mensual sale vacío',
    'Lentitud generalizada en la aplicación',
    'No llegan los correos de notificación',
    'Permisos insuficientes para exportar',
    'Duplicidad de registros tras la importación',
    'Caída del servicio de integración',
    'Solicitud de cambio de datos fiscales',
    'La búsqueda no encuentra resultados existentes',
    'Fallo al adjuntar documentos',
    'El total calculado no coincide',
    'Necesito restablecer la contraseña',
    'La sincronización quedó a medias',
    'Pantalla en blanco al entrar al módulo',
    'Solicito capacitación para el equipo',
    'El filtro por fechas devuelve datos de más',
    'Timeout al generar el consolidado'
  ])[1 + (a.i % 20)]
    || ' — ' ||
  (ARRAY[
    'módulo de facturación', 'portal de clientes', 'panel administrativo',
    'integración contable', 'app móvil', 'reportería', 'gestión documental',
    'catálogo de productos', 'control de inventario', 'pasarela de pagos',
    'notificaciones', 'auditoría', 'firma electrónica'
  ])[1 + (a.i % 13)],
  'Descripción reportada por el cliente. Se adjuntan capturas y el detalle del '
    || 'paso a paso hasta reproducir la incidencia. Referencia interna '
    || a.i::text || '.',
  a.est,
  a.prioridad,
  (SELECT ids[1 + floor(a.r_autor * n)::int] FROM autor),
  a.agente,
  CASE WHEN a.agente IS NOT NULL THEN a.creado + (a.r_asignado * interval '6 hours') END,
  CASE WHEN a.agente IS NOT NULL THEN a.creado + (a.r_asignado * interval '12 hours') END,
  a.resuelto,
  -- El resolutor no siempre es el asignado actual: en 15% de los casos el ticket
  -- se reasignó DESPUÉS de resolverse. Es exactamente el caso que justifica que
  -- resolved_by_user_id exista como columna propia (consulta 4).
  CASE WHEN a.est IN ('resolved', 'closed') THEN
    CASE WHEN a.r_resolutor < 0.85 THEN a.agente
         ELSE (SELECT ids[1 + floor(a.r_resolutor * n)::int] FROM ag) END
  END,
  a.cerrado,
  CASE WHEN a.r_reabierto < 0.88 THEN 0
       WHEN a.r_reabierto < 0.97 THEN 1
       ELSE 2 END,
  -- ~4% por encima de 2, que es el umbral de la consulta 7.
  -- Un ticket sin asignar no puede haberse reasignado: si no se fuerza a 0, el
  -- contador queda por encima de las filas reales de ticket_assignments y la
  -- consulta 7 devuelve más tickets que la versión que agrega el historial.
  -- Es la desnormalización mintiendo, que es justo lo que no puede pasar.
  CASE WHEN a.agente IS NULL THEN 0
       WHEN a.r_reasig < 0.70 THEN 0
       WHEN a.r_reasig < 0.88 THEN 1
       WHEN a.r_reasig < 0.96 THEN 2
       ELSE 3 + floor(a.r_reasig * 30)::int % 3 END,
  a.creado + (CASE a.prioridad WHEN 'critical' THEN interval '8 hours'
                               WHEN 'high'     THEN interval '24 hours'
                               WHEN 'medium'   THEN interval '72 hours'
                               ELSE interval '168 hours' END),
  a.ultima_actividad,
  a.creado,
  -- A PROPÓSITO distinto de last_activity_at: updated_at solo refleja cambios
  -- en campos del ticket, no comentarios. Es el motivo de que la consulta 3 no
  -- pueda usarlo.
  coalesce(a.cerrado, a.resuelto, a.creado + (a.r_asignado * interval '6 hours'), a.creado)
FROM actividad a;

-- >>>
-- Historial de asignaciones, consistente con tickets.reassignment_count:
-- se generan k+1 filas, la primera con from_user_id NULL (asignación inicial,
-- que no es una reasignación). Así reassignment_count es exactamente el número
-- de filas con from_user_id NOT NULL y la desnormalización no miente.
WITH ag AS (
  SELECT array_agg(u.id ORDER BY u.id) AS ids, count(*)::int AS n
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN roles r ON r.id = ur.role_id
  WHERE r.code = 'agent'
), sup AS (
  SELECT array_agg(u.id ORDER BY u.id) AS ids, count(*)::int AS n
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN roles r ON r.id = ur.role_id
  WHERE r.code IN ('supervisor', 'admin')
), cadena AS (
  SELECT t.id, t.created_at, t.last_activity_at, t.assigned_to_user_id,
         t.reassignment_count AS k,
         coalesce(
           (SELECT array_agg((SELECT ids[1 + floor(random() * n)::int] FROM ag))
            FROM generate_series(1, t.reassignment_count)),
           '{}'::uuid[]
         ) || ARRAY[t.assigned_to_user_id] AS secuencia
  FROM tickets t
  WHERE t.assigned_to_user_id IS NOT NULL
)
INSERT INTO ticket_assignments (
  ticket_id, from_user_id, to_user_id, assigned_by_user_id, reason, assigned_at
)
SELECT c.id,
       CASE WHEN o.ord > 1 THEN c.secuencia[o.ord - 1] END,
       o.uid,
       (SELECT ids[1 + floor(random() * n)::int] FROM sup),
       CASE WHEN o.ord = 1 THEN 'Asignación inicial'
            ELSE (ARRAY[
              'Reasignado por carga de trabajo',
              'Escalado a segundo nivel',
              'El agente anterior está fuera',
              'Requiere especialista del módulo'
            ])[1 + (o.ord % 4)] END,
       c.created_at + ((o.ord - 1)::numeric / (array_length(c.secuencia, 1) + 1))
                      * (c.last_activity_at - c.created_at)
FROM cadena c
CROSS JOIN LATERAL unnest(c.secuencia) WITH ORDINALITY AS o(uid, ord);

-- >>>
-- Historial de estados: append-only. El camino hasta el estado actual se deriva
-- del estado final, con los instantes repartidos entre la creación y la última
-- actividad.
WITH camino AS (
  SELECT t.id, t.created_at, t.last_activity_at, t.created_by_user_id,
         t.assigned_to_user_id,
         CASE t.status
           WHEN 'open'             THEN ARRAY['open']
           WHEN 'in_progress'      THEN ARRAY['open', 'in_progress']
           WHEN 'pending_customer' THEN ARRAY['open', 'in_progress', 'pending_customer']
           WHEN 'resolved'         THEN ARRAY['open', 'in_progress', 'resolved']
           ELSE                         ARRAY['open', 'in_progress', 'resolved', 'closed']
         END::ticket_status[] AS pasos
  FROM tickets t
)
INSERT INTO ticket_status_history (
  ticket_id, from_status, to_status, changed_by_user_id, note, changed_at
)
SELECT c.id,
       -- NULL en la creación del ticket.
       CASE WHEN o.ord > 1 THEN c.pasos[o.ord - 1] END,
       o.paso,
       -- Quien abre es el autor; los cambios posteriores los hace el agente.
       CASE WHEN o.ord = 1 THEN c.created_by_user_id
            ELSE coalesce(c.assigned_to_user_id, c.created_by_user_id) END,
       CASE WHEN o.ord = 1 THEN 'Ticket creado' END,
       c.created_at + ((o.ord - 1)::numeric / greatest(array_length(c.pasos, 1), 1))
                      * (c.last_activity_at - c.created_at)
FROM camino c
CROSS JOIN LATERAL unnest(c.pasos) WITH ORDINALITY AS o(paso, ord);

-- >>>
-- Comentarios: 0 a 6 por ticket, sesgado a pocos. Un 18% internos, que es lo que
-- da sentido a filtrar is_internal en la consulta y no en el front.
WITH ag AS (
  SELECT array_agg(u.id ORDER BY u.id) AS ids, count(*)::int AS n
  FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN roles r ON r.id = ur.role_id
  WHERE r.code = 'agent'
), cuantos AS (
  SELECT t.id, t.code, t.created_at, t.last_activity_at, t.created_by_user_id,
         t.assigned_to_user_id,
         floor(power(random(), 2) * 7)::int AS n_comentarios
  FROM tickets t
)
INSERT INTO ticket_comments (
  ticket_id, author_user_id, body, is_internal, created_at, updated_at
)
SELECT c.id,
       CASE WHEN g % 2 = 0 THEN coalesce(c.assigned_to_user_id, c.created_by_user_id)
            ELSE (SELECT ids[1 + floor(random() * n)::int] FROM ag) END,
       (ARRAY[
         'Se solicitó información adicional al cliente.',
         'Reproducido en el entorno de pruebas, se escala al equipo de desarrollo.',
         'El cliente confirma que el problema persiste tras el último despliegue.',
         'Nota interna: revisar la configuración del tenant antes de responder.',
         'Se aplicó la solución temporal, queda pendiente el arreglo definitivo.',
         'Sin respuesta del cliente en las últimas 48 horas.'
       ])[1 + ((g + length(c.code)) % 6)],
       random() < 0.18,
       ts.momento,
       ts.momento
FROM cuantos c
CROSS JOIN LATERAL generate_series(1, c.n_comentarios) AS g
CROSS JOIN LATERAL (
  SELECT c.created_at + (g::numeric / (c.n_comentarios + 1))
                        * (c.last_activity_at - c.created_at) AS momento
) AS ts;

-- >>>
-- La secuencia de códigos continúa tras el último sembrado. Sin esto, el primer
-- ticket creado desde la API tras un reseed chocaría contra uq_tickets_code.
SELECT setval('ticket_code_seq', current_setting('seed.tickets')::bigint);

-- >>>
-- Sin ANALYZE el planificador trabaja con estadísticas de una tabla vacía y
-- cualquier EXPLAIN posterior es ruido.
ANALYZE tickets, ticket_assignments, ticket_status_history, ticket_comments, clients, users;
