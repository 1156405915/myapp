import { Module } from '@nestjs/common';
import { DatabaseController } from './database.controller';
import { DatabaseService } from './database.service';
import { SshTunnelService } from './ssh-tunnel.service';

@Module({
  controllers: [DatabaseController],
  providers: [DatabaseService, SshTunnelService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
