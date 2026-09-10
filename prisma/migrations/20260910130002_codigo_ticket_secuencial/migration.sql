-- Código humano del ticket (TCK-000123) generado por la base.
--
-- Una secuencia es atómica bajo concurrencia; calcular max()+1 en la aplicación
-- no lo es: dos altas simultáneas leerían el mismo máximo y una fallaría contra
-- uq_tickets_code.
CREATE SEQUENCE ticket_code_seq AS bigint;

-- Arranca después del último código existente (el seed siembra TCK-000001 en
-- adelante). is_called = false en una tabla vacía para que el primero sea 1.
SELECT setval(
  'ticket_code_seq',
  coalesce((SELECT max(substring(code FROM 5)::bigint) FROM tickets), 1),
  (SELECT count(*) > 0 FROM tickets)
);

-- lpad(n, 6) TRUNCA a partir de 1.000.000 (lpad('1234567', 6) = '123456'), así
-- que el ancho crece con el número: 6 dígitos como mínimo, los que haga falta
-- a partir de ahí.
CREATE FUNCTION siguiente_codigo_ticket() RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT 'TCK-' || lpad(n::text, greatest(6, length(n::text)), '0')
  FROM nextval('ticket_code_seq') AS n
$$;

-- AlterTable
ALTER TABLE "tickets" ALTER COLUMN "code" SET DEFAULT siguiente_codigo_ticket();
