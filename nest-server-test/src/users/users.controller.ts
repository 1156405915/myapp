import { Controller, Get, Post, Body } from '@nestjs/common';
import { UsersService } from './users.service';
import { RegisterUserDto } from './dto/register-user.dto';
import { LoginUserDto } from './dto/login-user.dto';

@Controller('auth')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * 用户注册接口
   * @param registerDto 包含用户名、手机号和密码的注册信息
   * @returns 注册成功后的用户信息（不包含密码）
   */
  @Post('register')
  register(@Body() registerDto: RegisterUserDto) {
    return this.usersService.register(registerDto);
  }

  /**
   * 用户登录接口
   * @param loginDto 包含用户名/手机号和密码的登录信息
   * @returns 登录成功后的用户信息（不包含密码）
   */
  @Post('login')
  login(@Body() loginDto: LoginUserDto) {
    return this.usersService.login(loginDto);
  }

  /**
   * 获取所有用户列表接口
   * @returns 所有注册用户的列表（出于安全考虑，不包含密码字段）
   */
  @Get()
  findAll() {
    return this.usersService.findAll();
  }
}
