import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.resolve(__dirname, '../../../tools/puppeteer-bridge.js');
const MAPWRIGHT_DIR = path.resolve(__dirname, '../../..');

/**
 * Run the Puppeteer bridge as a child process.
 * @param {string[]} args — CLI arguments (e.g., ['--commands', '...', '--screenshot', 'out.png'])
 * @param {number} port — editor server port
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runBridge(args, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [BRIDGE_PATH, '--port', String(port), ...args], {
      cwd: MAPWRIGHT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = (s) => s.split('\n').slice(-40).join('\n');
        process.stderr.write(
          `\n[bridge exited code=${code}]\n` +
            `[bridge args] ${args.join(' ')}\n` +
            `[bridge stderr tail]\n${tail(stderr)}\n` +
            `[bridge stdout tail]\n${tail(stdout)}\n`,
        );
      }
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (e) => reject(e));
  });
}
