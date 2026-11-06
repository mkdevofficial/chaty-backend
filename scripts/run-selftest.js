import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.SELFTEST_PORT || '5050';
const baseUrl = `http://127.0.0.1:${port}`;
const selftestDir = path.join(rootDir, '.selftest');

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForHealth(timeoutMs) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 250));
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.cause?.code || error.message;
    }
    if (process.env.SELFTEST_DEBUG) console.error('health wait:', lastError);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (process.env.SELFTEST_DEBUG) console.error('last health error:', lastError);
  return false;
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

async function main() {
  await fs.rm(selftestDir, { recursive: true, force: true });
  await fs.mkdir(selftestDir, { recursive: true });

  const serverLog = [];
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: port,
      HOST: '127.0.0.1',
      DATA_DIR: path.join(selftestDir, 'data'),
      UPLOAD_DIR: path.join(selftestDir, 'uploads'),
      DB_PATH: path.join(selftestDir, 'data', 'chaty.db'),
      LOG_LEVEL: process.env.SELFTEST_SERVER_LOG_LEVEL || 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const collect = (chunk) => {
    serverLog.push(chunk.toString());
    if (serverLog.join('').length > 40_000) serverLog.splice(0, serverLog.length - 20);
  };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);

  let serverExited = false;
  server.on('exit', () => {
    serverExited = true;
  });

  const healthy = await waitForHealth(20_000);
  if (!healthy) {
    console.error('Selftest server did not become healthy.');
    if (serverLog.length) console.error(serverLog.join(''));
    if (!serverExited) {
      server.kill('SIGKILL');
      await waitForExit(server, 3000);
    }
    process.exitCode = 1;
    return;
  }

  const result = await run(process.execPath, ['scripts/selftest.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      SELFTEST_BASE_URL: baseUrl,
      SELFTEST_DB_PATH: path.join(selftestDir, 'data', 'chaty.db'),
    },
    stdio: 'inherit',
  });

  let graceful = false;
  if (!serverExited) {
    server.kill('SIGTERM');
    graceful = await waitForExit(server, 8000);
    if (!graceful) {
      console.error('Server did not shut down gracefully within 8s; forcing exit.');
      server.kill('SIGKILL');
      await waitForExit(server, 3000);
    }
  }

  if (graceful) console.log('Server shut down gracefully.');

  if (result.code === 0) {
    await fs.rm(selftestDir, { recursive: true, force: true });
  } else if (serverLog.length) {
    console.error('\nServer log:');
    console.error(serverLog.join(''));
  }

  process.exitCode = result.code;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
