import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { RegisterUserDto } from './dto/register-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  /**
   * 注册新用户
   * 1. 检查用户名或手机号是否已被注册
   * 2. 使用 bcryptjs 对密码进行加盐哈希处理
   * 3. 将新用户保存到数据库
   * @param registerDto 注册请求数据传输对象
   * @returns 注册成功的响应信息和用户数据（过滤掉密码）
   * @throws HttpException 当用户名或手机号已存在时抛出 400 错误
   */
  async register(registerDto: RegisterUserDto) {
    const { username, phone, password } = registerDto;

    const existingUser = await this.usersRepository.findOne({
      where: [{ username }, { phone }],
    });

    if (existingUser) {
      throw new HttpException(
        'Username or phone already exists',
        HttpStatus.BAD_REQUEST,
      );
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = this.usersRepository.create({
      username,
      phone,
      password: hashedPassword,
    });

    await this.usersRepository.save(newUser);

    // Don't return password
    const { password: _, ...result } = newUser;
    return {
      message: 'User registered successfully',
      data: result,
    };
  }

  /**
   * 用户登录验证
   * 1. 根据用户名或手机号查找用户
   * 2. 比对提交的密码和数据库中的哈希密码
   * @param loginDto 登录请求数据传输对象
   * @returns 登录成功的响应信息和用户数据（过滤掉密码）
   * @throws HttpException 当用户不存在返回 404，密码错误返回 401
   */
  async login(loginDto: LoginUserDto) {
    const { username, phone, password } = loginDto;

    const user = await this.usersRepository.findOne({
      where: username ? { username } : { phone },
    });

    if (!user || !user.password) {
      throw new HttpException('Invalid credentials', HttpStatus.UNAUTHORIZED);
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw new HttpException('Invalid credentials', HttpStatus.UNAUTHORIZED);
    }

    // Return user info without password
    const { password: _, ...result } = user;
    return {
      message: 'Login successful',
      data: result,
    };
  }

  /**
   * 获取所有注册用户的列表
   * 遍历并过滤掉所有用户的密码字段，保证数据安全
   * @returns 包含所有用户数据（不含密码）的数组
   */
  async findAll() {
    const users = await this.usersRepository.find();
    // Exclude passwords
    return users.map((user) => {
      const { password, ...result } = user;
      return result;
    });
  }
}
