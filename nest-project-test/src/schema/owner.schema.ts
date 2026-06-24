import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OwnerDocument = HydratedDocument<Owner>;

export class Owner {
  @Prop()
  name!: string;
}

export const OwnerSchema = SchemaFactory.createForClass(Owner);