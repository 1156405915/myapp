import { IsString, IsNotEmpty, ValidateIf } from 'class-validator';

export class LoginUserDto {
  @ValidateIf((o) => !o.phone)
  @IsString()
  @IsNotEmpty()
  username?: string;

  @ValidateIf((o) => !o.username)
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
