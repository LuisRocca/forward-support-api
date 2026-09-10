import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

import { TicketPriority, TicketStatus } from '../../generated/prisma/enums.js';

const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTicketDto {
  @IsUUID()
  clientId!: string;

  // IsOptional deja pasar null: "sin categoría" es un valor válido.
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @Transform(recortar)
  @IsString()
  @Length(5, 200)
  title!: string;

  @Transform(recortar)
  @IsString()
  @Length(10, 10000)
  description!: string;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  /** Solo admin y supervisor pueden asignar en la creación. */
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string | null;
}

/** Deliberadamente sin status ni asignación: esos van por sus endpoints. */
export class UpdateTicketDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(5, 200)
  title?: string;

  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Length(10, 10000)
  description?: string;

  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  dueAt?: string | null;
}

export class ChangeStatusDto {
  @IsEnum(TicketStatus)
  status!: TicketStatus;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class AssignTicketDto {
  @IsUUID()
  assignedToUserId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class CreateCommentDto {
  // Recortado antes de validar: un comentario de solo espacios no es un comentario.
  @Transform(recortar)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}
