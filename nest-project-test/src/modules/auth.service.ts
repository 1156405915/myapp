import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from './users.service';
import { LoginDto } from './auth/dto/login.dto';
import { RegisterDto } from './auth/dto/register.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const user = await this.usersService.create(registerDto);

    return this.buildAuthResult(String(user._id), user.email);
  }

  async login(loginDto: LoginDto) {
    const user = await this.usersService.validateUser(loginDto.username, loginDto.password);

    if (!user) {
      throw new UnauthorizedException('Username or password is incorrect');
    }

    await this.usersService.updateLastLoginAt(String(user._id));

    return this.buildAuthResult(String(user._id), user.email);
  }

  async getProfile(userId: string) {
    return this.usersService.findOne(userId);
  }

  private buildAuthResult(userId: string, email: string) {
    const accessToken = this.jwtService.sign({ sub: userId, email });
    
    return {
      accessToken,
      tokenType: 'Bearer',
      userId,
      email,
    };
  }
}