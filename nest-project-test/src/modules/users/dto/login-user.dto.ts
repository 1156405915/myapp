import { IsNotEmpty, IsString, Length } from 'class-validator';

export class LoginUserDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 50)
  username!: string;

  @IsString()
  @Length(8, 32)
  password!: string;
}