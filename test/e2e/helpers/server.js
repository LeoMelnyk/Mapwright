import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPWRIGHT_DIR = path.resolve(__dirname, '../../..');

let serverProcess = null;
let serverPort = null;

/**
 * Start the Express server on a random port.
 * Returns the port number.
 */
export async function startServer() {
  serverPort = 3100 + Math.floor(Math.random() * 900);

  serverProcess = spawn('node', ['server.js', String(serverPort)], {
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
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
    serverPort = null;
    // Brief wait for port release
    await new Promise(r => setTimeout(r, 500));
  }
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
