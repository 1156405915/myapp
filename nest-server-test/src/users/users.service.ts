import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes, pbkdf2Sync } from 'crypto';
import { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../database/database.service';
import { CreateUserDto } from './dto/create-user.dto';

export type User = RowDataPacket & {
  id: number;
  name: string;
  email: string;
  phone: string;
  password: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(private readonly databaseService: DatabaseService) {}

  // 应用启动时自动创建用户表。
  async onModuleInit() {
    await this.databaseService.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(20) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // 根据邮箱查询用户。
  async findByEmail(email: string): Promise<User | undefined> {
    const rows = await this.databaseService.query<User[]>(
      'SELECT id, name, email, phone, password, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE email = ?',
      [email],
    );
    return rows[0];
  }

  // 根据手机号查询用户。
  async findByPhone(phone: string): Promise<User | undefined> {
    const rows = await this.databaseService.query<User[]>(
      'SELECT id, name, email, phone, password, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE phone = ?',
      [phone],
    );
    return rows[0];
  }

  // 注册新用户。
  async register(dto: CreateUserDto): Promise<Omit<User, 'password'>> {
    const existingEmail = await this.findByEmail(dto.email);
    if (existingEmail) {
      throw new Error('该邮箱已被注册');
    }

    const existingPhone = await this.findByPhone(dto.phone);
    if (existingPhone) {
      throw new Error('该手机号已被注册');
    }

    const hashedPassword = this.hashPassword(dto.password);

    const result = await this.databaseService.query<ResultSetHeader>(
      'INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)',
      [dto.name, dto.email, dto.phone, hashedPassword],
    );

    return {
      id: result.insertId,
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  // 使用 PBKDF2 对密码进行加盐哈希。
  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString(
      'hex',
    );
    return `${salt}:${hash}`;
  }
}
