import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NewsDocument = HydratedDocument<News>;

@Schema({
  collection: 'news',
  timestamps: true,
})
export class News {
  @Prop({ required: true, trim: true, maxlength: 200 })
  title!: string;

  @Prop({ required: true, unique: true, trim: true })
  sourceId!: string;

  @Prop({ trim: true, maxlength: 500 })
  url?: string;

  @Prop({ trim: true, maxlength: 50 })
  source!: string;

  @Prop({ type: Number, default: 0 })
  hot!: number;

  @Prop({ type: Date, default: Date.now })
  fetchedAt!: Date;
}

export const NewsSchema = SchemaFactory.createForClass(News);

NewsSchema.index({ sourceId: 1 }, { unique: true });
NewsSchema.index({ fetchedAt: -1 });