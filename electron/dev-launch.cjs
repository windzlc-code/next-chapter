const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const electronBinary = require('electron');

const defaultDevUrl = process.env.INFINIO_ELECTRON_DEV_URL || 'http://127.0.0.1:8080';
const url = process.env.VITE_DEV_SERVER_URL || process.env.HOME_AGENT_SMOKE_URL || defaultDevUrl;
const timeoutMs = 30000;
const httpRequestTimeoutMs = Number(process.env.INFINIO_DEV_HTTP_TIMEOUT_MS || 5000);
const parsedDevUrl = new URL(url);
const devServerHost = parsedDevUrl.hostname || '127.0.0.1';
const devServerPort = parsedDevUrl.port || '8080';
const mainModuleUrl = new URL('/src/main.tsx', url).toString();
const proxyHost = process.env.AI_PROXY_HOST || '127.0.0.1';
const proxyPort = Number(process.env.AI_PROXY_PORT || 3001);
const proxyHealthUrl = `http://${proxyHost}:${proxyPort}/healthz`;
const viteBinPath = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
const workspaceRoot = process.cwd().toLowerCase();

let devServerChild = null;
let proxyServerChild = null;
let electronChild = null;
let startedLocalServer = false;
let shuttingDown = false;

function isExpectedDevServer(body) {
  return (
    typeof body === 'string' &&
    body.includes('<div id="root"></div>') &&
    body.includes('/src/main.tsx')
  );
}

function isExpectedMainModule(body) {
  return (
    typeof body === 'string' &&
    body.includes('createRoot') &&
    body.includes('App from') &&
    body.includes('/src/App.tsx')
  );
}

function requestTextOnce(targetUrl) {
  return new Promise((resolve) => {
    const request = http.get(targetUrl, (res) => {
      const chunks = [];

      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      res.on('end', () => {
        resolve({
          reachable: true,
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.setTimeout(httpRequestTimeoutMs, () => {
      request.destroy(new Error('request timeout'));
    });

    request.on('error', (error) => {
      resolve({
        reachable: false,
        statusCode: 0,
        body: '',
        error,
      });
    });
  });
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({
          stdout,
          stderr,
        });
      },
    );
  });
}

function probePortOnce(host = devServerHost, port = Number(devServerPort)) {
  return new Promise((resolve) => {
    const socket = net.connect(
      {
        host,
        port,
      },
      () => {
        socket.destroy();
        resolve(true);
      },
    );

    socket.setTimeout(500);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

async function probeServerOnce() {
  const pageProbe = await requestTextOnce(url);
  const pageReusable =
    pageProbe.reachable &&
    pageProbe.statusCode >= 200 &&
    pageProbe.statusCode < 300 &&
    isExpectedDevServer(pageProbe.body);

  if (!pageReusable) {
    if (pageProbe.reachable) {
      return {
        reachable: true,
        reusable: false,
        statusCode: pageProbe.statusCode,
      };
    }

    const listening = await probePortOnce();
    return {
      reachable: listening,
      reusable: false,
      statusCode: 0,
      error: pageProbe.error,
    };
  }

  const mainModuleProbe = await requestTextOnce(mainModuleUrl);
  const mainModuleReusable =
    mainModuleProbe.reachable &&
    mainModuleProbe.statusCode >= 200 &&
    mainModuleProbe.statusCode < 300 &&
    isExpectedMainModule(mainModuleProbe.body);

  return {
    reachable: true,
    reusable: mainModuleReusable,
    statusCode: pageProbe.statusCode,
    error: mainModuleProbe.error,
  };
}

async function waitForListeningPort(host = devServerHost, port = Number(devServerPort), deadlineMs = timeoutMs) {
  const start = Date.now();

  while (Date.now() - start <= deadlineMs) {
    if (await probePortOnce(host, port)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

async function getListeningProcessId(port) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileText('powershell', [
        '-NoProfile',
        '-Command',
        `$conn = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 OwningProcess; if ($conn) { $conn | ConvertTo-Json -Compress }`,
      ]);
      const payload = stdout.trim();
      if (!payload) return null;
      const data = JSON.parse(payload);
      const pid = Number(data?.OwningProcess ?? data);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileText('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t']);
    const pid = Number(String(stdout).trim().split(/\s+/)[0] || 0);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function getProcessInfo(pid) {
  if (!pid) return null;

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileText('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
      ]);
      const payload = stdout.trim();
      if (!payload) return null;
      const data = JSON.parse(payload);
      return {
        pid: Number(data?.ProcessId || pid),
        name: String(data?.Name || ''),
        commandLine: String(data?.CommandLine || ''),
      };
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileText('ps', ['-p', String(pid), '-o', 'pid=,comm=,args=']);
    const line = String(stdout).trim();
    if (!line) return null;
    const [pidText, name, ...args] = line.split(/\s+/);
    return {
      pid: Number(pidText || pid),
      name: String(name || ''),
      commandLine: args.join(' '),
    };
  } catch {
    return null;
  }
}

function formatProcessInfo(processInfo) {
  if (!processInfo) return 'unknown process';
  const summary = processInfo.commandLine || processInfo.name || 'unknown process';
  return `pid ${processInfo.pid}: ${summary}`;
}

function isManagedPortBlocker(port, processInfo) {
  if (!processInfo) return false;

  const name = String(processInfo.name || '').toLowerCase();
  const commandLine = String(processInfo.commandLine || '').toLowerCase();
  const portNumber = Number(port);

  if (!name.includes('node')) {
    return false;
  }

  if (portNumber === Number(proxyPort)) {
    return (
      commandLine.includes('server/ai-proxy.mjs') ||
      commandLine.includes('server\\ai-proxy.mjs')
    );
  }

  if (portNumber === Number(devServerPort)) {
    return (
      commandLine.includes('/vite/bin/vite.js') ||
      commandLine.includes('\\vite\\bin\\vite.js') ||
      (commandLine.includes('vite') && commandLine.includes(workspaceRoot))
    );
  }

  return false;
}

async function killPidTree(pid) {
  if (!pid) return;

  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', (code) => {
        if (code === 0 || code === 128 || code === 255) {
          resolve();
          return;
        }
        reject(new Error(`taskkill exited with code ${code}`));
      });
      killer.on('error', reject);
    });
    return;
  }

  process.kill(pid, 'SIGTERM');
}

async function clearManagedPortBlocker(host, port, label) {
  const pid = await getListeningProcessId(port);
  if (!pid) {
    return false;
  }

  const processInfo = await getProcessInfo(pid);
  if (!isManagedPortBlocker(port, processInfo)) {
    return false;
  }

  console.warn(`[dev-launch] Clearing stale ${label} on port ${port}: ${formatProcessInfo(processInfo)}`);
  await killPidTree(pid);

  const released = await waitForPortRelease(host, port, 5000);
  if (!released) {
    throw new Error(`Failed to clear stale ${label} on port ${port}`);
  }

  return true;
}

async function waitForPortRelease(host, port, deadlineMs = 5000) {
  const start = Date.now();

  while (Date.now() - start <= deadlineMs) {
    if (!(await probePortOnce(host, Number(port)))) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

async function waitForReusableDevServer(deadlineMs = 3000) {
  const start = Date.now();

  while (Date.now() - start <= deadlineMs) {
    const probe = await probeServerOnce();
    if (probe.reusable || !probe.reachable) {
      return probe;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return probeServerOnce();
}

async function isHealthyProxyServer() {
  const probe = await requestTextOnce(proxyHealthUrl);
  return (
    probe.reachable &&
    probe.statusCode >= 200 &&
    probe.statusCode < 300 &&
    probe.body.trim() === 'ok'
  );
}

function stopProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }

    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
      return;
    }

    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;

  await Promise.all([
    stopProcessTree(electronChild),
    stopProcessTree(proxyServerChild),
    startedLocalServer ? stopProcessTree(devServerChild) : Promise.resolve(),
  ]);
}

function warmupServerInBackground() {
  const request = http.get(url, (res) => {
    res.resume();
    console.log(`[dev-launch] Background warmup response ${res.statusCode ?? 0} from ${url}`);
  });

  request.setTimeout(timeoutMs, () => {
    request.destroy(new Error('warmup timeout'));
  });

  request.on('error', (error) => {
    console.warn('[dev-launch] Background warmup is still pending:', error.message);
  });
}

function launchElectron(devServerReusable) {
  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: url,
    INFINIO_DEV_LAUNCH_PID: String(process.pid),
    INFINIO_DEV_SERVER_PID: startedLocalServer && devServerChild?.pid ? String(devServerChild.pid) : '',
    INFINIO_DEV_SERVER_REUSABLE: devServerReusable ? '1' : '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log('[dev-launch] Launching Electron...');
  electronChild = spawn(electronBinary, ['.'], {
    stdio: 'inherit',
    env,
  });

  electronChild.on('exit', async (code, signal) => {
    console.log(`[dev-launch] Electron exited with code ${code}, signal ${signal}`);
    await cleanup();
    process.exit(code || 0);
  });

  electronChild.on('error', async (err) => {
    console.error('[dev-launch] Failed to start Electron:', err);
    await cleanup();
    process.exit(1);
  });
}

function startLocalProxyServer() {
  return spawn(process.execPath, ['server/ai-proxy.mjs'], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
  });
}

function startLocalViteServer() {
  return spawn(process.execPath, [viteBinPath, '--host', devServerHost, '--port', devServerPort], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
  });
}

async function ensureProxyServer() {
  if (await isHealthyProxyServer()) {
    console.log(`[dev-launch] Reusing existing AI proxy at http://${proxyHost}:${proxyPort}`);
    return;
  }

  if (await probePortOnce(proxyHost, proxyPort)) {
    const cleared = await clearManagedPortBlocker(proxyHost, proxyPort, 'AI proxy blocker');
    if (!cleared) {
      const pid = await getListeningProcessId(proxyPort);
      const processInfo = await getProcessInfo(pid);
      throw new Error(
        `Port ${proxyPort} is occupied by a non-managed process (${formatProcessInfo(processInfo)}). ` +
        'Please free that port or move the conflicting service.',
      );
    }
  }

  console.log(`[dev-launch] Starting local AI proxy at http://${proxyHost}:${proxyPort}`);
  proxyServerChild = startLocalProxyServer();
  const proxyListening = await waitForListeningPort(proxyHost, proxyPort, 5000);
  if (!proxyListening) {
    console.warn(
      `[dev-launch] AI proxy is not listening on http://${proxyHost}:${proxyPort} yet. ` +
      'Startup will continue, but API requests may fail until it is ready.',
    );
  }
}

async function ensureDevServer() {
  const initialProbe = await probeServerOnce();
  if (initialProbe.reusable) {
    await ensureProxyServer();
    console.log(`[dev-launch] Reusing existing dev server at ${url}`);
    return true;
  }

  if (initialProbe.reachable) {
    const settledProbe = await waitForReusableDevServer();
    if (settledProbe.reusable) {
      await ensureProxyServer();
      console.log(`[dev-launch] Reusing existing dev server at ${url}`);
      return true;
    }

    const cleared = await clearManagedPortBlocker(devServerHost, devServerPort, 'dev server blocker');
    if (!cleared) {
      const pid = await getListeningProcessId(devServerPort);
      const processInfo = await getProcessInfo(pid);
      throw new Error(
        `Port ${devServerPort} is already occupied by a non-managed process (${formatProcessInfo(processInfo)}) at ${url}. ` +
        'Please free that port or move the conflicting service.',
      );
    }
  }

  await ensureProxyServer();
  console.log(`[dev-launch] Starting local dev server at ${url}`);
  devServerChild = startLocalViteServer();
  startedLocalServer = true;

  const listening = await waitForListeningPort();
  if (!listening) {
    throw new Error(`Timed out waiting for port ${devServerPort} to start listening`);
  }

  warmupServerInBackground();
  return false;
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

process.on('exit', () => {
  if (startedLocalServer && devServerChild && !devServerChild.killed) {
    void stopProcessTree(devServerChild);
  }
});

(async () => {
  try {
    const devServerReusable = await ensureDevServer();
    launchElectron(devServerReusable);
  } catch (error) {
    console.error(
      '[dev-launch] Failed to prepare Electron dev startup:',
      error instanceof Error ? error.message : error,
    );
    await cleanup();
    process.exit(1);
  }
})();
