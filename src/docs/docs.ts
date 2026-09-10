// Swagger UI servida desde docs/api-contract.yaml TAL CUAL.
//
// No se genera un contrato desde decoradores: la fuente de verdad compartida
// con el front es el YAML, y dos contratos acaban divergiendo.
//
// El YAML se sirve crudo en su propia URL y la UI lo descarga de ahí: lo que se
// ve es literalmente el fichero, sin parser de YAML en el servidor. Se lee en
// cada petición y no al arrancar, porque el contrato se edita a menudo y el
// modo watch solo reinicia con cambios en src/.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';

const CONTRATO = resolve('docs/api-contract.yaml');
const URL_CONTRATO = '/docs/openapi.yaml';

export function montarDocumentacion(app: NestExpressApplication): void {
  // Si se pidió la documentación y no está el fichero, que no arranque: mejor
  // que un /docs que responde vacío.
  if (!existsSync(CONTRATO)) {
    throw new Error(`DOCS_ENABLED está activo pero no existe ${CONTRATO}`);
  }

  // Antes que /docs: si no, el estático de la UI interceptaría esta ruta.
  app.use(URL_CONTRATO, (_peticion: Request, respuesta: Response, siguiente: NextFunction) => {
    readFile(CONTRATO, 'utf8')
      .then((yaml) => respuesta.type('application/yaml').send(yaml))
      .catch(siguiente);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(undefined, { swaggerOptions: { url: URL_CONTRATO } }));
}
