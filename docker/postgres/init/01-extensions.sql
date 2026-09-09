-- Se ejecuta una sola vez, al inicializar el volumen de datos.
-- Postgres 18 trae uuidv7() y gen_random_uuid() en el core: no hace falta pgcrypto.

-- Comparación de texto sin distinguir mayúsculas, para users.email:
-- evita que "Luis@x.com" y "luis@x.com" se registren como dos cuentas.
CREATE EXTENSION IF NOT EXISTS citext;

-- Índices GIN de trigramas para la búsqueda parcial por título de ticket
-- y nombre de cliente. Sin esto, un ILIKE '%texto%' es seq scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
