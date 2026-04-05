import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPWRIGHT_DIR = path.resolve(__dirname, '../../..');

let serverProcess = null;
let serverPort = null;
let reusedExisting = false;

/**
 * Start the Express server on a random port.
 * If a server is already running on port 3000 (e.g. started by pre-commit hook),
 * reuse it instead of spawning a new one.
 * Returns the port number.
 */
export async function startServer() {
  // Check if a server is already running on port 3000
  if (await isPortUp(3000)) {
    serverPort = 3000;
    reusedExisting = true;
    return serverPort;
  }

  serverPort = 3100 + Math.floor(Math.random() * 900);

  serverProcess = spawn('node', ['--import', 'tsx', 'server.js', String(serverPort)], {
    cwd: MAPWRIGHT_DIR,
    stdio: 'pipe',
  });

  // Capture and ignore stdout/stderr to prevent test output noise
  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', () => {});

  await waitForPort(serverPort, 15000);
  return serverPort;
}

/**
 * Stop the server process.
 */
export async function stopServer() {
  if (reusedExisting) {
    // Don't kill a server we didn't start
    reusedExisting = false;
    serverPort = null;
    return;
  }
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
    serverPort = null;
    // Brief wait for port release
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Quick check if a port is already responding.
 */
function isPortUp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Poll until the server responds on the given port.
 */
function waitForPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server did not start within ${timeoutMs}ms on port ${port}`));
      }
      const req = http.get(`http://localhost:${port}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        setTimeout(check, 300);
      });
      req.end();
    }
    check();
  });
}
