import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 50)
  username!: string;

  @Transform(({ value }) => String(value).trim().toLowerCase())
  @IsEmail()
  email!: string;

  @IsString()
  @Length(8, 32)
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{6,20}$/)
  phone?: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  nickname?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}