import { Controller, Post, Body } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';

/**
 * 聊天会话控制器，提供对外暴露的接口路由
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  /**
   * 新增会话接口
   * @param createConversationDto 创建会话所需的参数
   * @returns 新增的会话信息
   */
  @Post()
  create(@Body() createConversationDto: CreateConversationDto) {
    return this.conversationsService.create(createConversationDto);
  }
}
