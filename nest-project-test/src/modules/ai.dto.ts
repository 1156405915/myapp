import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MoonshotMessageDto {
  @IsString()
  role!: string;

  @IsString()
  content!: string;
}

export class MoonshotChatDto {
  @IsOptional()
  @IsString()
  chatId?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  system?: string;

  @IsString()
  prompt!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MoonshotMessageDto)
  history?: MoonshotMessageDto[];
}

export class CreateAiChatDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  system?: string;
}
