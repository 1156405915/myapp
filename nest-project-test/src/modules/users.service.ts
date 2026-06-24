import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { hash, compare } from 'bcryptjs';
import { Model } from 'mongoose';
import { User, UserDocument } from '../schema/user.schema';
import { CreateUserDto } from './users/dto/create-user.dto';
import { UpdateUserDto } from './users/dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

  async create(createUserDto: CreateUserDto) {
    const existedUser = await this.userModel.exists({ username: createUserDto.username });

    if (existedUser) {
      throw new ConflictException('Username already exists');
    }

    const hashedPassword = await hash(createUserDto.password, 10);

    return this.userModel.create({
      ...createUserDto,
      password: hashedPassword,
    });
  }

  async validateUser(username: string, password: string) {
    const user = await this.userModel
      .findOne({ username })
      .select('+password')
      .exec();
    if (!user) {
      return null;
    }

    const isPasswordValid =  await compare(password, user.password); // password === user.password
    console.log(isPasswordValid, password, user.password)
    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  async updateLastLoginAt(id: string) {
    await this.userModel.findByIdAndUpdate(id, { lastLoginAt: new Date() }).exec();
  }

  findAll() {
    return this.userModel.find().select('-password').exec();
  }

  async findOne(id: string) {
    const user = await this.userModel.findById(id).select('-password').exec();

    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    if (updateUserDto.username) {
      const existedUser = await this.userModel.exists({
        username: updateUserDto.username,
        _id: { $ne: id },
      });

      if (existedUser) {
        throw new ConflictException('Username already exists');
      }
    }

    const user = await this.userModel
      .findByIdAndUpdate(id, updateUserDto, { new: true, runValidators: true })
      .select('-password')
      .exec();

    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    return user;
  }

  async remove(id: string) {
    const user = await this.userModel.findByIdAndDelete(id).select('-password').exec();

    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    return user;
  }
}