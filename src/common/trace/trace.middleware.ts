// Identificador por petición. Va en el cuerpo del error y en el log del
// servidor: es lo que permite correlacionar lo que vio el usuario con lo que
// pasó de verdad, sin exponerle el detalle interno.
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express' {
  interface Request {
    traceId?: string;
  }
}

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    req.traceId = randomUUID();
    next();
  }
}
