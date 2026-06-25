import { IsString, IsNotEmpty, Length } from 'class-validator';

export class RegisterUserDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  @Length(11, 11, { message: 'Phone number must be exactly 11 characters' })
  phone: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 20, { message: 'Password must be between 6 and 20 characters' })
  password: string;
}
