import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController, TestController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      expandVariables: true,
    }),
    DatabaseModule,
    UsersModule,
  ],
  controllers: [AppController, TestController],
  providers: [AppService],
})
export class AppModule {}
