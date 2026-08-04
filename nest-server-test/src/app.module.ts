import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { ConversationsModule } from './conversations/conversations.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // 可以在全局任意地方使用 ConfigService
    }),
    DatabaseModule,
    UsersModule,
    ConversationsModule,
    AiModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
