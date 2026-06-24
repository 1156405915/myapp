/**
 * 应用程序的根模块。
 */

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './modules/auth.module';
import { UsersModule } from './modules/users.module';
import { AiModule } from './modules/ai.module';

const nodeEnv = process.env.NODE_ENV ?? 'development';

@Module({
  // forRoot() 方法接收与 Mongoose 包中 mongoose.connect() 相同的配置对象
  // imports: [MongooseModule.forRoot('mongodb://localhost/nest')],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // 使配置模块在整个应用程序中全局可用
      envFilePath: [`.env.${nodeEnv}`, '.env'],
    }),
    ScheduleModule.forRoot(),
    MongooseModule.forRootAsync({
      inject: [ConfigService], // 注入 ConfigService 以便在工厂函数中使用
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('MONGO_URI'),
      }),
    }),

    AuthModule,
    UsersModule,
    AiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
