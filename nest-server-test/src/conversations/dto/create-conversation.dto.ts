import { IsNotEmpty, IsString, IsNumber } from 'class-validator';

/**
 * 创建会话时传入的数据传输对象 (DTO)
 * 验证请求体中的 title 和 userId。
 */
export class CreateConversationDto {
  @IsString()
  @IsNotEmpty({ message: '会话标题不能为空' })
  title: string;

  @IsNumber()
  @IsNotEmpty({ message: '用户ID不能为空' })
  userId: number;
}
