import fs from 'fs';
import path from 'path';
import os from 'os';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR   = path.join(os.homedir(), '.wipeit', 'logs');
const datestamp = new Date().toISOString().slice(0, 10);
export const LOG_FILE = path.join(LOG_DIR, `wipeit-${datestamp}.log`);

// Create log dir safely — degrade gracefully if not writable
let logStream: fs.WriteStream | null = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch {
  // Logging silently disabled if ~/.wipeit/logs is not writable
}

function write(level: LogLevel, msg: string): void {
  if (!logStream) return;
  try {
    logStream.write(`[${new Date().toISOString()}] [${level.padEnd(5)}] ${msg}\n`);
  } catch {
    // Swallow write errors — don't crash the app over logging
  }
}

export const logger = {
  info:  (msg: string): void => write('INFO',  msg),
  warn:  (msg: string): void => write('WARN',  msg),
  error: (msg: string): void => write('ERROR', msg),
  separator(): void { write('INFO', '─'.repeat(60)); },

  /** Flush and close the stream — call before process.exit() */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!logStream) { resolve(); return; }
      logStream.end(resolve);
    });
  },
};
