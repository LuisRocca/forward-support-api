// Paginación por keyset, nunca por OFFSET.
//
// Con OFFSET 100000 Postgres lee y descarta 100.000 filas: la página 10.000
// cuesta 10.000 veces la primera. Con keyset todas cuestan lo mismo, porque el
// índice se posiciona directamente en la última fila devuelta.
//
// El cursor es opaco a propósito: si el cliente pudiera interpretarlo acabaría
// construyéndolo a mano y el servidor no podría cambiar el criterio de orden
// sin romperlo.
import { AppError } from '../problem/app-error.js';
import { CodigoError } from '../problem/problem.js';

export interface Cursor {
  /** Valor del campo de orden en la última fila de la página anterior. */
  valor: string;
  /** Desempate estable: dos filas pueden compartir el valor de orden, el id no. */
  id: string;
}

export interface Pagina<T> {
  data: T[];
  pageInfo: {
    /** Siempre presente: `null` distingue "no hay más" de "no me lo mandaron". */
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export function codificarCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodificarCursor(valor: string): Cursor {
  try {
    const plano: unknown = JSON.parse(Buffer.from(valor, 'base64url').toString('utf8'));
    if (
      typeof plano === 'object' &&
      plano !== null &&
      typeof (plano as Cursor).valor === 'string' &&
      typeof (plano as Cursor).id === 'string'
    ) {
      return plano as Cursor;
    }
  } catch {
    // Cae al error de abajo: un cursor ilegible es entrada inválida, no un 500.
  }
  throw new AppError(
    CodigoError.VALIDATION_ERROR,
    422,
    'Cursor inválido',
    'El cursor no es uno devuelto por esta API. Pide la primera página sin cursor.',
    [{ field: 'cursor', message: 'No es un cursor válido' }],
  );
}

/**
 * Se piden `limit + 1` filas: si vuelve la de más, hay página siguiente. Evita
 * el COUNT(*) sobre el filtro, que es justo la consulta que se cae con volumen.
 */
export function construirPagina<T extends { id: string }>(
  filas: T[],
  limite: number,
  valorDeOrden: (fila: T) => string,
): Pagina<T> {
  const hasMore = filas.length > limite;
  const data = hasMore ? filas.slice(0, limite) : filas;
  const ultima = data.at(-1);

  return {
    data,
    pageInfo: {
      nextCursor:
        hasMore && ultima !== undefined
          ? codificarCursor({ valor: valorDeOrden(ultima), id: ultima.id })
          : null,
      hasMore,
    },
  };
}

/**
 * Condición de continuación para Prisma.
 *
 * Se expande en OR en vez de comparar tuplas —`(campo, id) < (v, i)`, que
 * Prisma no expresa— pero es equivalente y el planificador la resuelve con el
 * mismo índice compuesto.
 */
export function condicionKeyset(
  campo: string,
  cursor: Cursor,
  descendente: boolean,
  valorTipado: unknown,
): Record<string, unknown> {
  const operador = descendente ? 'lt' : 'gt';
  return {
    OR: [
      { [campo]: { [operador]: valorTipado } },
      { [campo]: valorTipado, id: { [operador]: cursor.id } },
    ],
  };
}
