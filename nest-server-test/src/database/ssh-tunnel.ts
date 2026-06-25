import { Client, ConnectConfig } from 'ssh2';
import * as net from 'net';

/**
 * SSH 隧道配置接口
 */
export interface TunnelConfig {
  /** SSH 客户端连接配置（主机、端口、用户名、密码或私钥等） */
  sshConfig: ConnectConfig;
  /** 要通过隧道访问的目标远程主机（例如内网的 MySQL 服务器 IP 或 localhost） */
  remoteHost: string;
  /** 要通过隧道访问的目标远程端口（例如 MySQL 的 3306） */
  remotePort: number;
  /** 本地用于监听映射的 TCP 端口 */
  localPort: number;
}

/**
 * 创建并启动一个 SSH 隧道服务器
 * 该函数会在本地启动一个 TCP 服务，所有连接到 `localPort` 的请求都会通过 SSH 转发到 `remoteHost:remotePort`
 *
 * @param config 隧道连接的详细配置
 * @returns 返回一个 Promise，成功时提供本地运行的 TCP Server 实例
 * @throws 当本地端口被占用或服务启动失败时抛出异常
 */
export function createSshTunnel(config: TunnelConfig): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const sshClient = new Client();

      sshClient.on('ready', () => {
        sshClient.forwardOut(
          '127.0.0.1',
          socket.remotePort || 0, // mock source port
          config.remoteHost,
          config.remotePort,
          (err, stream) => {
            if (err) {
              socket.end();
              sshClient.end();
              return;
            }
            socket.pipe(stream).pipe(socket);

            socket.on('close', () => sshClient.end());
            socket.on('error', () => sshClient.end());
          },
        );
      });

      sshClient.on('error', (err) => {
        console.error('SSH Client Error:', err);
        socket.end();
      });

      sshClient.connect(config.sshConfig);
    });

    server.listen(config.localPort, '127.0.0.1', () => {
      resolve(server);
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}
