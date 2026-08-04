import { Module } from '@nestjs/common';
import { ClaudeAgentController } from './agent/claude-agent.controller';
import { ClaudeAgentService } from './agent/claude-agent.service';

@Module({
  providers: [ClaudeAgentService],
  controllers: [ClaudeAgentController],
})
export class AiModule {}
