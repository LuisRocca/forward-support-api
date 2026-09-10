# Mediciones reales — las consultas 3 y 7 sobre 100.000 tickets

> No son estimaciones. Salen de ejecutar `EXPLAIN (ANALYZE, BUFFERS)` contra
> `forward_db_dev` (PostgreSQL 18.6, puerto 5442) con el volumen que genera
> `pnpm db:seed`. Reproducible: el seed usa `setseed(0.42)`.

## Volumen medido

```

[0m         tabla         | filas  | tamano
-----------------------+--------+--------
 ticket_status_history | 320455 | 54 MB
 ticket_comments       | 189870 | 43 MB
 ticket_assignments    | 148989 | 29 MB
 tickets               | 100000 | 80 MB
 clients               |    200 | 280 kB
 users                 |     40 | 64 kB
 user_roles            |     40 | 40 kB
 ticket_categories     |      8 | 48 kB
 roles                 |      3 | 48 kB
 _prisma_migrations    |      2 | 32 kB
(10 rows)

```

`ANALYZE` corre al final del seed. Sin estadísticas actualizadas el planificador
trabaja con las de una tabla vacía y cualquier medición posterior es ruido.

---

## Consulta 3 — no cerrados con más de 48h sin actividad

**Lo que hay que defender:** el filtro está escrito para calzar exactamente con el
índice parcial `idx_tickets_stale`, así que Postgres no toca la tabla completa.

```

[0m                                                                          QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.60..63.21 rows=100 width=141) (actual time=0.085..0.681 rows=100.00 loops=1)
   Buffers: shared hit=326 read=2
   ->  Nested Loop Left Join  (cost=0.60..24573.98 rows=39251 width=141) (actual time=0.084..0.673 rows=100.00 loops=1)
         Buffers: shared hit=326 read=2
         ->  Nested Loop  (cost=0.45..23306.25 rows=39251 width=127) (actual time=0.065..0.585 rows=100.00 loops=1)
               Buffers: shared hit=260 read=2
               ->  Index Scan using idx_tickets_stale on tickets t  (cost=0.29..22295.10 rows=39251 width=118) (actual time=0.034..0.410 rows=100.00 loops=1)
                     Index Cond: (last_activity_at < (now() - '48:00:00'::interval))
                     Index Searches: 1
                     Buffers: shared hit=100 read=2
               ->  Memoize  (cost=0.15..0.17 rows=1 width=41) (actual time=0.001..0.001 rows=1.00 loops=100)
                     Cache Key: t.client_id
                     Cache Mode: logical
                     Hits: 20  Misses: 80  Evictions: 0  Overflows: 0  Memory Usage: 12kB
                     Buffers: shared hit=160
                     ->  Index Scan using clients_pkey on clients c  (cost=0.14..0.16 rows=1 width=41) (actual time=0.001..0.001 rows=1.00 loops=80)
                           Index Cond: (id = t.client_id)
                           Index Searches: 80
                           Buffers: shared hit=160
         ->  Memoize  (cost=0.15..0.17 rows=1 width=30) (actual time=0.001..0.001 rows=1.00 loops=100)
               Cache Key: t.assigned_to_user_id
               Cache Mode: logical
               Hits: 67  Misses: 33  Evictions: 0  Overflows: 0  Memory Usage: 5kB
               Buffers: shared hit=66
               ->  Index Scan using users_pkey on users u  (cost=0.14..0.16 rows=1 width=30) (actual time=0.001..0.001 rows=1.00 loops=33)
                     Index Cond: (id = t.assigned_to_user_id)
                     Index Searches: 33
                     Buffers: shared hit=66
 Planning:
   Buffers: shared hit=543 read=13 dirtied=2
 Planning Time: 4.004 ms
 Execution Time: 0.837 ms
(32 rows)

```

**Lectura del plan:**

| Dato | Valor | Por qué importa |
|---|---|---|
| Acceso | `Index Scan using idx_tickets_stale` | No hay `Seq Scan`: no lee los 100.000 tickets |
| `Buffers: shared hit` | 328 | 2,6 MB tocados sobre una tabla de 80 MB |
| Sin `Sort` | — | El índice ya viene ordenado por `last_activity_at`, que es el `ORDER BY`. El `LIMIT 100` corta la lectura ahí |
| Tiempo | **0,8 ms** | — |

Lo que hace que esto escale no es solo el índice, es que **el índice da el orden**:
el `LIMIT 100` para de leer en la fila 100 y el coste deja de depender de cuántos
tickets estancados haya en total. Con 10 millones de tickets el plan es el mismo.

El índice es **parcial** (`WHERE status <> 'closed' AND deleted_at IS NULL`) y por
eso ocupa **1.192 kB** en lugar de los ~5.000 kB de un índice completo sobre la
misma columna: los cerrados son el 55% del volumen y nunca se consultan por
antigüedad, así que no se indexan. Un índice cuatro veces más pequeño es un
índice que cabe en caché.

**Y el motivo de que la columna exista:** `updated_at` no cambia cuando alguien
comenta. Sobre estos mismos datos las dos versiones no coinciden — el seed pone
`updated_at` a propósito solo en los cambios de campos del ticket, igual que
pasaría en producción. Filtrar por `updated_at` lista como estancados tickets con
comentarios de hoy.

---

## Consulta 7 — reasignados más de dos veces

```

[0m                                                                            QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.72..255.44 rows=100 width=127) (actual time=0.068..0.697 rows=100.00 loops=1)
   Buffers: shared hit=337
   ->  Nested Loop Left Join  (cost=0.72..9883.79 rows=3880 width=127) (actual time=0.068..0.688 rows=100.00 loops=1)
         Buffers: shared hit=337
         ->  Nested Loop  (cost=0.57..9782.38 rows=3880 width=129) (actual time=0.056..0.597 rows=100.00 loops=1)
               Buffers: shared hit=267
               ->  Index Scan using idx_tickets_reasignados on tickets t  (cost=0.42..9651.58 rows=3880 width=120) (actual time=0.028..0.443 rows=100.00 loops=1)
                     Index Cond: (reassignment_count > 2)
                     Filter: (deleted_at IS NULL)
                     Index Searches: 1
                     Buffers: shared hit=103
               ->  Memoize  (cost=0.15..0.18 rows=1 width=41) (actual time=0.001..0.001 rows=1.00 loops=100)
                     Cache Key: t.client_id
                     Cache Mode: logical
                     Hits: 18  Misses: 82  Evictions: 0  Overflows: 0  Memory Usage: 13kB
                     Buffers: shared hit=164
                     ->  Index Scan using clients_pkey on clients c  (cost=0.14..0.17 rows=1 width=41) (actual time=0.001..0.001 rows=1.00 loops=82)
                           Index Cond: (id = t.client_id)
                           Index Searches: 82
                           Buffers: shared hit=164
         ->  Memoize  (cost=0.15..0.17 rows=1 width=30) (actual time=0.001..0.001 rows=1.00 loops=100)
               Cache Key: t.assigned_to_user_id
               Cache Mode: logical
               Hits: 65  Misses: 35  Evictions: 0  Overflows: 0  Memory Usage: 5kB
               Buffers: shared hit=70
               ->  Index Scan using users_pkey on users u  (cost=0.14..0.16 rows=1 width=30) (actual time=0.001..0.001 rows=1.00 loops=35)
                     Index Cond: (id = t.assigned_to_user_id)
                     Index Searches: 35
                     Buffers: shared hit=70
 Planning:
   Buffers: shared hit=560
 Planning Time: 3.960 ms
 Execution Time: 0.868 ms
(33 rows)

```

**Lectura del plan:** `Index Scan using idx_tickets_reasignados`, 337 buffers,
**0,9 ms**, y de nuevo sin `Sort`.

### Este índice no estaba en el modelo original, y hacía falta

El modelo justificaba `reassignment_count` como desnormalización para no agregar
sobre `ticket_assignments`. El argumento es correcto pero estaba incompleto: sin
un índice sobre la columna, la consulta **seguía leyendo la tabla entera**.

Medido, las tres versiones sobre los mismos datos:

| Versión | Plan | Buffers | Tiempo |
|---|---|---|---|
| Contador **sin** índice | `Seq Scan` + `Sort`, 95.943 filas descartadas por el filtro | 5.284 | 24,1 ms |
| Agregando el historial completo (`GROUP BY ... HAVING count(*) > 2`) | `HashAggregate` sobre `Seq Scan` de 148.989 filas | 2.444 | 20,4 ms |
| Contador **con** índice | `Index Scan`, sin `Sort` | 337 | **0,9 ms** |

El dato incómodo es el del medio: **sin índice, la desnormalización era más lenta
que la consulta que pretendía evitar** (24,1 ms contra 20,4 ms). Desnormalizar sin
indexar la columna desnormalizada no compra nada — solo añade una columna que hay
que mantener en transacción. Con el índice, 26 veces más rápido y 15 veces menos
buffers.

Y otra vez lo que importa de verdad es el orden: el índice es
`(reassignment_count DESC, created_at DESC)`, que es exactamente el `ORDER BY` de
la consulta, así que el `LIMIT 100` corta y el coste no crece con la tabla.

### Por qué el índice no es parcial

Un `WHERE reassignment_count > 2` indexaría solo el ~4% de filas que pasan el
umbral: medido, **144 kB frente a 3 MB**. Pero el preview `partialIndexes` de
Prisma solo admite igualdad y `not`, así que un umbral `> 2` solo se expresa en
SQL a mano, y entonces `prisma migrate dev` intentaría borrarlo en cada migración
siguiente: drift permanente entre el esquema y la base.

Medidos los dos, **el plan y el tiempo son idénticos** (0,4 ms y ~337 buffers en
ambos). La diferencia es 2,9 MB sobre una tabla de 80 MB. No compensa pagar drift
permanente por eso. Si algún día la tabla crece hasta que esos MB importen, se
cambia por el parcial en SQL a mano y se asume el coste de mantenerlo.

### Verificación de que el contador no miente

Una desnormalización solo vale si el número coincide con la realidad. Sobre los
100.000 tickets:

```
 por_contador | por_historial | inconsistentes
--------------+---------------+----------------
         3943 |          3943 |              0
(1 row)
```

- `por_contador` — `WHERE reassignment_count > 2`
- `por_historial` — `GROUP BY ticket_id HAVING count(*) > 2` sobre las filas de
  `ticket_assignments` con `from_user_id IS NOT NULL`
- `inconsistentes` — tickets donde el contador no cuadra con sus filas de
  historial, **sobre todos los tickets**, no solo los asignados

Las dos formas dan el mismo número. La consulta de verificación queda aquí para
poder repetirla:

```sql
SELECT
  (SELECT count(*) FROM tickets
    WHERE reassignment_count > 2 AND deleted_at IS NULL)              AS por_contador,
  (SELECT count(*) FROM (
     SELECT ticket_id FROM ticket_assignments
     WHERE from_user_id IS NOT NULL
     GROUP BY ticket_id HAVING count(*) > 2) x)                       AS por_historial,
  (SELECT count(*) FROM tickets t
   LEFT JOIN (SELECT ticket_id, count(*) FILTER (WHERE from_user_id IS NOT NULL) n
              FROM ticket_assignments GROUP BY 1) a ON a.ticket_id = t.id
   WHERE t.reassignment_count <> coalesce(a.n, 0))                    AS inconsistentes;
```

En la aplicación esa igualdad se sostiene porque el `INSERT` en
`ticket_assignments` y el `UPDATE` del contador van en la **misma transacción**.
La consulta de arriba es la que hay que correr si alguna vez se duda.

---

## Las otras cinco

Medidas también, para no afirmar de memoria lo que hace el planificador:

| # | Plan real | Tiempo | Lectura |
|---|---|---|---|
| 1 | `Seq Scan` sobre tickets (100.000 filas) + `HashAggregate` + `Sort` | 56,9 ms | Agrupa los 200 clientes sobre el total: hay que leerlo todo por definición. Es la más cara de las siete |
| 2 | **`Bitmap Index Scan` sobre `idx_tickets_status_priority`** (29.880 filas) + `Hash Join` + `HashAggregate` | 18,3 ms | El índice compuesto sí entra aquí: `priority IN ('high','critical')` es selectivo (30% de la tabla) y Postgres lo aprovecha aunque el índice empiece por `status` |
| 4 | `Seq Scan` sobre tickets con filtro por `resolved_at` (4.117 filas de 100.000) | 24,9 ms | Candidata clara a índice `(resolved_by_user_id, resolved_at)`: descarta el 96% de la tabla leyéndola entera. Hoy no lo justifica; con millones sí |
| 5 | `Seq Scan` + `HashAggregate` sobre 69.548 resueltos | 28,8 ms | Promedio sobre todos los resueltos: la lectura completa es inevitable |
| 6 | `Nested Loop` con **`Bitmap Index Scan` sobre `idx_tickets_assigned_status`**, una búsqueda por agente (35 loops) | 22,4 ms | No hace `Seq Scan`: recorre los 35 agentes y para cada uno va al índice. El índice compuesto sirve también para el informe global, no solo para filtrar por un agente |

Dos cosas que conviene decir en voz alta porque contradicen la intuición:

- **La consulta 1 es la más lenta de las siete** (56,9 ms), no la 3 ni la 7. Las
  que dan miedo por el enunciado son justo las que quedaron en menos de 1 ms; las
  caras son las agregaciones globales, que ningún índice arregla porque tienen que
  leer la tabla completa por definición. Lo que las arregla es no ejecutarlas en
  cada carga: **vista materializada** refrescada cada N minutos, que es lo que dice
  `DECISIONES-TECNICAS.md` de las métricas del dashboard.
- **La consulta 4 es la única de las cinco con un índice pendiente que sí valdría
  la pena.** Filtra por `resolved_at >= now() - 1 month` y descarta el 96% de las
  filas leyéndolas todas. Un índice `(resolved_by_user_id, resolved_at)` lo
  convertiría en un scan acotado. No se añade ahora porque con 100.000 filas son
  25 ms y añadir índices que nadie ha medido como necesarios es la otra forma de
  equivocarse; queda anotado como lo primero que hay que medir cuando el histórico
  crezca.
