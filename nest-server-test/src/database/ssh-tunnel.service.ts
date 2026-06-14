import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { createServer, Server, Socket } from 'node:net';
import { Client, ConnectConfig } from 'ssh2';

@Injectable()
export class SshTunnelService implements OnModuleDestroy {
  private readonly logger = new Logger(SshTunnelService.name);
  private client: Client | null = null;
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;

  // 注入配置服务，统一读取 SSH 隧道相关环境变量。
  constructor(private readonly configService: ConfigService) {}

  // 判断当前是否启用了 SSH 隧道模式。
  isEnabled() {
    return this.getBooleanEnv('MYSQL_SSH_ENABLED', false);
  }

  // 返回本地隧道监听地址，供数据库连接复用。
  getLocalHost() {
    return this.configService.get<string>('MYSQL_SSH_LOCAL_HOST', '127.0.0.1');
  }

  // 返回本地隧道监听端口，供数据库连接复用。
  getLocalPort() {
    return this.getNumberEnv('MYSQL_SSH_LOCAL_PORT', 3307);
  }

  // 返回 SSH 远端真正要访问的数据库主机名，例如 Docker 内的 db。
  getDestinationHost() {
    return (
      this.configService.get<string>('MYSQL_SSH_DST_HOST') ??
      this.configService.get<string>('MYSQL_HOST', 'db')
    );
  }

  // 返回 SSH 远端真正要访问的数据库端口。
  getDestinationPort() {
    return this.getNumberEnv(
      'MYSQL_SSH_DST_PORT',
      this.getNumberEnv('MYSQL_PORT', 3306),
    );
  }

  // 确保隧道只会被初始化一次，避免并发重复监听本地端口。
  async ensureTunnel() {
    if (!this.isEnabled()) {
      return;
    }

    if (this.client && this.server) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.startTunnel();
    }

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  // 在模块销毁时关闭本地转发和 SSH 连接。
  async onModuleDestroy() {
    await this.closeTunnel();
  }

  // 建立 SSH 连接并启动本地 TCP 转发服务。
  private async startTunnel() {
    const client = new Client();
    const server = createServer((socket) => this.forwardSocket(socket, client));

    try {
      await this.connectClient(client);
      await this.listenServer(server);
    } catch (error) {
      server.close();
      client.end();
      throw this.toTunnelException(error);
    }

    client.on('close', () => {
      if (this.client === client) {
        this.client = null;
      }

      if (this.server === server) {
        this.server = null;
      }

      void new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    client.on('error', (error) => {
      this.logger.error(
        `SSH tunnel client error to ${this.getSshHost()}:${this.getSshPort()}`,
        error.stack,
      );
    });

    server.on('error', (error) => {
      this.logger.error(
        `SSH tunnel local port error on ${this.getLocalHost()}:${this.getLocalPort()}`,
        error.stack,
      );
    });

    this.client = client;
    this.server = server;

    this.logger.log(
      `SSH tunnel ready on ${this.getLocalHost()}:${this.getLocalPort()} -> ` +
        `${this.getDestinationHost()}:${this.getDestinationPort()} via ` +
        `${this.getSshHost()}:${this.getSshPort()}`,
      );
  }

  // 等待 SSH 客户端完成握手并进入 ready 状态。
  private async connectClient(client: Client) {
    await new Promise<void>((resolve, reject) => {
      const handleReady = () => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        client.off('ready', handleReady);
        client.off('error', handleError);
      };

      client.on('ready', handleReady);
      client.on('error', handleError);
      client.connect(this.getSshConfig());
    });
  }

  // 启动本地监听端口，把数据库流量交给 SSH 客户端转发。
  private async listenServer(server: Server) {
    await new Promise<void>((resolve, reject) => {
      const handleListening = () => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        server.off('listening', handleListening);
        server.off('error', handleError);
      };

      server.once('listening', handleListening);
      server.once('error', handleError);
      server.listen(this.getLocalPort(), this.getLocalHost());
    });
  }

  // 将单个本地 socket 转发到远端 Docker 网络中的数据库地址。
  private forwardSocket(socket: Socket, client: Client) {
    client.forwardOut(
      socket.remoteAddress ?? this.getLocalHost(),
      socket.remotePort ?? 0,
      this.getDestinationHost(),
      this.getDestinationPort(),
      (error, stream) => {
        if (error) {
          this.logger.error(
            `SSH forward failed to ${this.getDestinationHost()}:${this.getDestinationPort()}`,
            error.stack,
          );
          socket.destroy(error);
          return;
        }

        socket.pipe(stream);
        stream.pipe(socket);

        socket.on('close', () => {
          stream.end();
        });

        stream.on('close', () => {
          socket.end();
        });

        socket.on('error', () => {
          stream.destroy();
        });

        stream.on('error', () => {
          socket.destroy();
        });
      },
    );
  }

  // 组装 ssh2 连接参数，并校验密码或私钥至少存在一种。
  private getSshConfig(): ConnectConfig {
    const username = this.getRequiredStringEnv('MYSQL_SSH_USERNAME');
    const password = this.configService.get<string>('MYSQL_SSH_PASSWORD');
    const privateKey = this.getPrivateKey();

    if (!password && !privateKey) {
      throw new ServiceUnavailableException(
        'MYSQL_SSH_ENABLED is true, but neither MYSQL_SSH_PASSWORD nor a private key is configured.',
      );
    }

    return {
      host: this.getSshHost(),
      port: this.getSshPort(),
      username,
      password: password || undefined,
      privateKey,
      passphrase:
        this.configService.get<string>('MYSQL_SSH_PRIVATE_KEY_PASSPHRASE') ||
        undefined,
      readyTimeout: this.getNumberEnv('MYSQL_SSH_READY_TIMEOUT', 10000),
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };
  }

  // 读取 SSH 服务器地址。
  private getSshHost() {
    return this.getRequiredStringEnv('MYSQL_SSH_HOST');
  }

  // 读取 SSH 服务器端口。
  private getSshPort() {
    return this.getNumberEnv('MYSQL_SSH_PORT', 22);
  }

  // 优先读取内联私钥，其次读取私钥文件内容。
  private getPrivateKey() {
    const inlineKey = this.configService.get<string>('MYSQL_SSH_PRIVATE_KEY');
    if (inlineKey) {
      return inlineKey.replace(/\\n/g, '\n');
    }

    const keyPath = this.configService.get<string>('MYSQL_SSH_PRIVATE_KEY_PATH');
    if (!keyPath) {
      return undefined;
    }

    try {
      return readFileSync(keyPath, 'utf8');
    } catch (error) {
      throw new ServiceUnavailableException(
        `Failed to read MYSQL_SSH_PRIVATE_KEY_PATH: ${keyPath}. ` +
          (error instanceof Error ? error.message : 'Unknown file error.'),
      );
    }
  }

  // 读取必填字符串环境变量，缺失时直接报配置错误。
  private getRequiredStringEnv(key: string) {
    const value = this.configService.get<string>(key);

    if (!value) {
      throw new ServiceUnavailableException(`${key} is required.`);
    }

    return value;
  }

  // 读取并校验数值型环境变量。
  private getNumberEnv(key: string, fallback: number) {
    const rawValue = this.configService.get<string>(key);

    if (!rawValue) {
      return fallback;
    }

    const parsedValue = Number(rawValue);

    if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
      throw new ServiceUnavailableException(
        `${key} must be a valid positive integer.`,
      );
    }

    return parsedValue;
  }

  // 读取布尔环境变量，兼容常见的 true/false 写法。
  private getBooleanEnv(key: string, fallback: boolean) {
    const rawValue = this.configService.get<string>(key);

    if (!rawValue) {
      return fallback;
    }

    return ['1', 'true', 'yes', 'on'].includes(rawValue.toLowerCase());
  }

  // 关闭本地监听端口和 SSH 客户端，释放隧道资源。
  private async closeTunnel() {
    const server = this.server;
    const client = this.client;

    this.server = null;
    this.client = null;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (client) {
      client.end();
    }
  }

  // 将底层隧道错误转换成更易读的业务异常。
  private toTunnelException(error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EADDRINUSE'
    ) {
      return new ServiceUnavailableException(
        `SSH tunnel local port ${this.getLocalPort()} is already in use. ` +
          'Set MYSQL_SSH_LOCAL_PORT to an unused port.',
      );
    }

    const message =
      error instanceof Error ? error.message : 'Unknown SSH tunnel error.';

    return new ServiceUnavailableException(
      `Failed to establish SSH tunnel via ${this.getSshHost()}:${this.getSshPort()} ` +
        `to ${this.getDestinationHost()}:${this.getDestinationPort()}. ${message}`,
    );
  }
}
