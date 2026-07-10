const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Packaging project...');
try {
  execSync('tar -czf project.tar.gz --exclude=node_modules --exclude=.git --exclude=dist --exclude=frontend/node_modules --exclude=frontend/dist .', { stdio: 'inherit' });
  console.log('Packaging complete.');
} catch (err) {
  console.error('Failed to package project:', err);
  process.exit(1);
}

// Basic manual parsing of .env
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^#\s]+)\s*=\s*(.*)$/);
  if (match) {
    env[match[1]] = match[2].trim();
  }
});

const conn = new Client();
const localFile = path.join(__dirname, 'project.tar.gz');
const remoteFile = '/home/ubuntu/project.tar.gz';
const targetDir = '/home/ubuntu/myapp';

conn.on('ready', () => {
  console.log('SSH Client :: ready');
  conn.sftp((err, sftp) => {
    if (err) throw err;
    console.log('SFTP :: ready');
    
    console.log(`Uploading ${localFile} to ${remoteFile}...`);
    sftp.fastPut(localFile, remoteFile, (err) => {
      if (err) throw err;
      console.log('Upload complete.');
      
      console.log(`Extracting ${remoteFile} into ${targetDir}...`);
      conn.exec(`mkdir -p ${targetDir} && tar -xzf ${remoteFile} -C ${targetDir} && rm ${remoteFile}`, (err, stream) => {
        if (err) throw err;
        stream.on('close', (code, signal) => {
          console.log(`Extraction closed with code: ${code}`);
          
          console.log('Cleaning up local temporary files...');
          if (fs.existsSync(localFile)) {
            fs.unlinkSync(localFile);
          }
          
          conn.end();
          console.log('Done! 🚀');
        }).on('data', (data) => {
          console.log('STDOUT: ' + data);
        }).stderr.on('data', (data) => {
          console.error('STDERR: ' + data);
        });
      });
    });
  });
}).connect({
  host: env.SSH_HOST,
  port: parseInt(env.SSH_PORT || '22', 10),
  username: env.SSH_USER,
  password: env.SSH_PASSWORD
});
