import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { UserStatus } from '../../generated/prisma/enums.js';

export class ListUsersDto {
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
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsIn(['admin', 'supervisor', 'agent'])
  roleCode?: string;
}

export class BlockUserDto {
  @IsString()
  @Length(3, 255)
  reason!: string;
}
