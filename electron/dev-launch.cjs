const http = require('node:http');
const { spawn } = require('node:child_process');
const electronBinary = require('electron');

const url = 'http://127.0.0.1:8080';
const timeoutMs = 30000;
const start = Date.now();

function waitForServer() {
  http.get(url, (res) => {
    res.resume();
    if (res.statusCode && res.statusCode < 500) {
      launchElectron();
      return;
    }
    retry();
  }).on('error', retry);
}

function retry() {
  if (Date.now() - start > timeoutMs) {
    console.error(`Timed out waiting for ${url}`);
    process.exit(1);
    return;
  }
  setTimeout(waitForServer, 500);
}

function launchElectron() {
  const env = { ...process.env, VITE_DEV_SERVER_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log('[dev-launch] Launching Electron...');
  const child = spawn(electronBinary, ['.'], {
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code, signal) => {
    console.log(`[dev-launch] Electron exited with code ${code}, signal ${signal}`);
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    console.error('[dev-launch] Failed to start Electron:', err);
    process.exit(1);
  });
}

waitForServer();
