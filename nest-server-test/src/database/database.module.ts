import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Server } from 'net';
import * as fs from 'fs';
import { ConnectConfig } from 'ssh2';
import { createSshTunnel } from './ssh-tunnel';

let tunnelServer: Server | null = null;

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const isProd = configService.get<string>('NODE_ENV') === 'production';
        let dbHost = configService.get<string>('DB_HOST') || '127.0.0.1';
        let dbPort = parseInt(
          configService.get<string>('DB_PORT') || '3306',
          10,
        );

        // 如果不是生产环境且配置了 SSH_HOST，则启动 SSH 隧道
        const sshHost = configService.get<string>('SSH_HOST');
        if (!isProd && sshHost) {
          const sshPort = parseInt(
            configService.get<string>('SSH_PORT') || '22',
            10,
          );
          const sshUser = configService.get<string>('SSH_USER') || 'ubuntu';
          const sshPassword = configService.get<string>('SSH_PASSWORD');
          const sshPrivateKey = configService.get<string>('SSH_PRIVATE_KEY');
          const sshPrivateKeyPath = configService.get<string>(
            'SSH_PRIVATE_KEY_PATH',
          );

          const localPort = 33060; // 映射到本地的端口

          // 确保全局只有一个 SSH 隧道实例被创建（防止热更新或多次连接时重复创建）
          if (!tunnelServer) {
            console.log(`Starting SSH Tunnel to ${sshHost}:${sshPort}...`);

            // 构造 SSH 连接的基本配置
            const sshConfig: ConnectConfig = {
              host: sshHost,
              port: sshPort,
              username: sshUser,
            };

            // 根据环境变量判断使用哪种 SSH 认证方式：
            // 1. 密码认证优先
            // 2. 其次是直接传入私钥字符串（需要处理环境变量中的换行符）
            // 3. 最后是指定私钥文件路径进行读取
            if (sshPassword) {
              sshConfig.password = sshPassword;
            } else if (sshPrivateKey) {
              sshConfig.privateKey = sshPrivateKey.replace(/\\n/g, '\n');
            } else if (sshPrivateKeyPath) {
              sshConfig.privateKey = fs.readFileSync(sshPrivateKeyPath);
            }

            // 调用底层方法建立隧道，将本地的 localPort 映射到远程服务器的 dbHost:dbPort
            tunnelServer = await createSshTunnel({
              sshConfig,
              remoteHost: dbHost,
              remotePort: dbPort,
              localPort: localPort,
            });
            console.log(`SSH Tunnel started on 127.0.0.1:${localPort}`);
          }

          // 隧道建立成功后，将 TypeORM 的连接目标重写为本地映射的端口
          // 这样 TypeORM 的数据库请求会发给本地，再由隧道安全地转发到远程数据库
          dbHost = '127.0.0.1';
          dbPort = localPort;
        }

        return {
          type: 'mysql',
          host: dbHost,
          port: dbPort,
          username: configService.get<string>('DB_USER') || 'root',
          password: configService.get<string>('DB_PASSWORD') || '',
          database: configService.get<string>('DB_NAME') || 'test',
          autoLoadEntities: true,
          synchronize: !isProd, // 生产环境请勿开启 synchronize
        };
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
