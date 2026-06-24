import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cat, CatDocument } from '../schema/cat.schema';
import { CreateCatDto } from './cats/dto/create-cat.dto';
import { UpdateCatDto } from './cats/dto/update-cat.dto';

@Injectable()
export class CatsService {
  constructor(@InjectModel(Cat.name) private readonly catModel: Model<CatDocument>) {}

  create(createCatDto: CreateCatDto) {
    return this.catModel.create(createCatDto);
  }

  findAll() {
    return this.catModel.find().exec();
  }

  async findOne(id: string) {
    const cat = await this.catModel.findById(id).exec();

    if (!cat) {
      throw new NotFoundException(`Cat with id ${id} not found`);
    }

    return cat;
  }

  async update(id: string, updateCatDto: UpdateCatDto) {
    const cat = await this.catModel
      .findByIdAndUpdate(id, updateCatDto, { new: true, runValidators: true })
      .exec();

    if (!cat) {
      throw new NotFoundException(`Cat with id ${id} not found`);
    }

    return cat;
  }

  async remove(id: string) {
    const cat = await this.catModel.findByIdAndDelete(id).exec();

    if (!cat) {
      throw new NotFoundException(`Cat with id ${id} not found`);
    }

    return cat;
  }
}
