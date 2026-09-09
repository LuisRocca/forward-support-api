# Problemas conocidos y soluciones aplicadas

> Antes de depurar algo raro del entorno, revisar esta tabla primero.
> Formato: **problema → causa → fix / prevención**.

| # | Problema | Causa | Fix / prevención |
|---|---|---|---|
| 1 | `docker compose up` falla con `rootlessport listen tcp 0.0.0.0:5433: bind: address already in use` | Otro proyecto de la máquina ya tenía un Postgres publicado en 5433. 5432 y 5433 son los puertos que usa todo el mundo. | Los puertos del proyecto son **5442 (dev)** y **5443 (test)**, y son overrideables por `POSTGRES_PORT` / `POSTGRES_TEST_PORT`. Al arrancar un proyecto nuevo, elegir un par de puertos propio en vez de los de por defecto. |
| 2 | El contenedor de Postgres entra en bucle de reinicio y en los logs solo aparece `ls: can't open '/docker-entrypoint-initdb.d/': Permission denied` | SELinux (Fedora/RHEL con podman) bloquea los bind mounts que no llevan etiqueta. El error no menciona SELinux, lo cual despista. | Añadir `:z` a la opción del bind mount → `./docker/postgres/init:/docker-entrypoint-initdb.d:ro,z`. Docker sobre hosts sin SELinux ignora la opción, así que el compose sigue siendo portable. |
| 3 | Con `postgres:18`, montar el volumen en `/var/lib/postgresql/data` no persiste nada: cada reinicio arranca con una base vacía | Postgres 18 cambió `PGDATA` a `/var/lib/postgresql/18/docker`. El mount clásico apunta a una ruta que ya no es el directorio de datos, y el contenedor arranca sin quejarse. | Montar el volumen en **`/var/lib/postgresql`** (el padre). Verificado: se crea una tabla, se reinicia el contenedor y la fila sigue ahí. Comprobar con `podman exec <c> printenv PGDATA` al subir de versión mayor. |
| 4 | El PDF del enunciado llega con viñetas `• ...` truncadas | No es el extractor de texto: el propio PDF tiene las listas cortadas (campos del ticket, estados, prioridades, ítems de las vistas del front). | Las 7 consultas de `queries.sql` son el único requisito completo y sin ambigüedad. El modelo se diseñó a partir de ellas; todo lo demás queda documentado como asunción explícita en `DECISIONES-TECNICAS.md`. |
