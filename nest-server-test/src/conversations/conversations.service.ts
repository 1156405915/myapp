import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './entities/conversation.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';

/**
 * 聊天会话服务，处理新增会话等相关业务逻辑
 */
@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
  ) {}

  /**
   * 新增聊天会话记录
   * @param createConversationDto 包含会话标题和关联的用户ID
   * @returns 保存成功后的会话实体
   */
  async create(createConversationDto: CreateConversationDto): Promise<Conversation> {
    const conversation = this.conversationRepository.create(createConversationDto);
    return await this.conversationRepository.save(conversation);
  }
}
