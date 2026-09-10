import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  // Se normaliza a minúsculas al entrar. La columna es citext, así que la
  // búsqueda ya sería insensible, pero normalizar aquí hace que la clave del
  // rate limiting sea la misma escriba el usuario como escriba su email: sin
  // esto, alternar mayúsculas daría un contador distinto por variante y el
  // límite se saltaría solo.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Debe ser un email válido' })
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Debe tener al menos 8 caracteres' })
  @MaxLength(128)
  password!: string;
}
