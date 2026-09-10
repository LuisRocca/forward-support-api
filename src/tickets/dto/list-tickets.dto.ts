import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { TicketPriority, TicketStatus } from '../../generated/prisma/enums.js';

/** Un solo valor en la query llega como string; repetido, como array. */
function aArray(valor: unknown): unknown {
  if (valor === undefined || valor === null) return undefined;
  return Array.isArray(valor) ? valor : [valor];
}

export const ORDENES = [
  'createdAt',
  '-createdAt',
  'lastActivityAt',
  '-lastActivityAt',
  'priority',
  '-priority',
] as const;

export type Orden = (typeof ORDENES)[number];

export class ListTicketsDto {
  // El tope existe para que nadie pida 100.000 filas de una vez.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => aArray(value))
  @IsArray()
  @IsEnum(TicketStatus, { each: true })
  status?: TicketStatus[];

  @IsOptional()
  @Transform(({ value }) => aArray(value))
  @IsArray()
  @IsEnum(TicketPriority, { each: true })
  priority?: TicketPriority[];

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** UUID, o el valor especial `unassigned` para la bandeja sin asignar. */
  @IsOptional()
  @IsString()
  assignedToUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  /** Vista de "tickets estancados": no cerrados y sin actividad desde hace N horas. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  staleHours?: number;

  @IsOptional()
  @IsIn(ORDENES)
  sort: Orden = '-createdAt';
}
