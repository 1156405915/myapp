import { Body, Controller, Get, Param, Post, Res, Sse, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CreateAiChatDto, MoonshotChatDto } from './ai.dto';
import { AiService } from './ai.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('sessions')
  createSession(@Body() createAiChatDto: CreateAiChatDto) {
    return this.aiService.createSession(createAiChatDto);
  }

  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    return this.aiService.getSession(id);
  }
  
  @UseGuards(JwtAuthGuard)
  @Post('chat')
  chat(@Body() chatDto: MoonshotChatDto) {
    return this.aiService.chat(chatDto);
  }

  @Sse('chat/stream')
  stream(@Body() chatDto: MoonshotChatDto, @Res() res: Response) {
    return this.aiService.streamChat(chatDto, res);
  }
}
