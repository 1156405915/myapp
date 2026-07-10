import { Controller, Post, Body } from '@nestjs/common';
import { AiService } from './ai.service';
import { IsNotEmpty, IsString } from 'class-validator';

export class ChatDto {
  @IsString()
  @IsNotEmpty({ message: '消息不能为空' })
  message: string;
}

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   * 接收用户消息，调用 DeepSeek 智能问答并返回结果。
   */
  @Post('chat')
  async chat(@Body() chatDto: ChatDto) {
    const result = await this.aiService.chat(chatDto.message);
    return {
      success: true,
      data: result,
    };
  }
}
