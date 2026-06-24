import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AiChatDocument = HydratedDocument<AiChat>;

@Schema({ _id: false })
export class AiChatMessage {
  @Prop({ required: true, enum: ['system', 'user', 'assistant'] })
  role!: string;

  @Prop({ required: true, trim: true, maxLength: 20000 })
  content!: string;

  @Prop({ type: Date, default: Date.now })
  createdAt!: Date;
}

const AiChatMessageSchema = SchemaFactory.createForClass(AiChatMessage);

@Schema({
  collection: 'ai_chats',
  timestamps: true,
})
export class AiChat {
  @Prop({ required: true, trim: true, maxLength: 100 })
  title!: string;

  @Prop({ required: true, trim: true, maxLength: 50, default: 'moonshot-v1-8k' })
  modelName!: string;

  @Prop({ trim: true, maxLength: 4000 })
  system?: string;

  @Prop({ type: [AiChatMessageSchema], default: [] })
  messages!: AiChatMessage[];
}

export const AiChatSchema = SchemaFactory.createForClass(AiChat);

AiChatSchema.index({ createdAt: -1 }); // createdAt: -1：按创建时间倒序建索引 // -1 表示降序，1 表示升序
AiChatSchema.index({ updatedAt: -1 }); // updatedAt: -1：按更新时间倒序建索引 // -1 表示降序，1 表示升序
