import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { Owner } from './owner.schema';
export type CatDocument = HydratedDocument<Cat>;

/**
 * @Schema() 装饰器将一个类标记为模式定义。
 * 它将我们的 Cat 类映射到同名的 MongoDB 集合，但末尾会添加一个"s"——因此最终的 Mongo 集合名称将是 cats。该装饰器接受一个可选参数，即模式选项对象。
 */
@Schema({
  collection: 'cats',
  timestamps: true,
})
export class Cat {
  @Prop({required: true}) // @Prop() 装饰器用于在文档中定义属性
  name: string;

  @Prop({required: true})
  age: number;

  @Prop()
  breed: string;

  @Prop()
  tags: string[];

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Owner' })
  owner: Owner;

  @Prop({ type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Owner' }] })
  owners: Owner[];

  @Prop(raw({
    name: { type: String },
    age: { type: Number },
    breed: { type: String },
  }))
  details: Record<string, any>;
}

export const CatSchema = SchemaFactory.createForClass(Cat);