import fs from 'fs';
import { spawn } from 'child_process';
import type { AccessStatus } from './types.js';

/** Run `du -sh <path>` safely using spawn (no shell, no injection risk). */
function duSize(dirPath: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn('du', ['-sh', dirPath], { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('close', () => {
      const out = Buffer.concat(chunks).toString('utf8');
      resolve(out.split('\t')[0]?.trim() ?? '?');
    });
    proc.on('error', () => resolve('?'));

    // Kill if takes too long
    setTimeout(() => { proc.kill(); resolve('?'); }, 8_000).unref();
  });
}

export async function getSize(dirPath: string): Promise<string> {
  try {
    return await duSize(dirPath);
  } catch {
    return '?';
  }
}

export async function checkAccess(dirPath: string): Promise<AccessStatus> {
  try {
    await fs.promises.access(dirPath, fs.constants.W_OK);
    return 'writable';
  } catch {
    try {
      await fs.promises.access(dirPath, fs.constants.R_OK);
      return 'readonly';
    } catch {
      return 'noaccess';
    }
  }
}

export async function getMtime(dirPath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}
