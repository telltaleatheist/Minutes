/**
 * Rolling file logger for the main process.
 *
 * Tees every console.log/info/warn/error (plus uncaught crashes and the
 * [llama-server] / whisper output that already goes through console) to a file
 * in the app's logs directory, so problems are diagnosable after the fact even
 * in a packaged build with no terminal attached.
 *
 * Size-bounded: the active log rotates to main.1.log, main.2.log, … once it hits
 * MAX_BYTES, and only MAX_FILES are kept, so the logs never exceed
 * MAX_BYTES * MAX_FILES on disk. Tune the two constants to change the cap.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { app } = require('electron');

// Cap: 5 MB per file × 6 files ≈ 30 MB total on disk.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 6;

let logDir = '';
let logFile = '';
let currentBytes = 0;
let initialized = false;

function resolveLogDir(): string {
  try {
    return app.getPath('logs');
  } catch {
    /* getPath('logs') can be unavailable very early; fall back to userData */
  }
  try {
    return path.join(app.getPath('userData'), 'logs');
  } catch {
    return '';
  }
}

/** Rotate main.log → main.1.log → … dropping the oldest beyond MAX_FILES. */
function rotate(): void {
  try {
    const oldest = path.join(logDir, `main.${MAX_FILES - 1}.log`);
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = MAX_FILES - 2; i >= 1; i--) {
      const src = path.join(logDir, `main.${i}.log`);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(logDir, `main.${i + 1}.log`));
    }
    if (fs.existsSync(logFile)) fs.renameSync(logFile, path.join(logDir, 'main.1.log'));
  } catch {
    /* a failed rotation must never take down logging */
  }
  currentBytes = 0;
}

function format(args: any[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 120 })))
    .join(' ');
}

function writeLine(level: string, args: any[]): void {
  if (!initialized) return;
  let line: string;
  try {
    line = `${new Date().toISOString()} [${level}] ${format(args)}\n`;
  } catch {
    return;
  }
  try {
    const len = Buffer.byteLength(line);
    if (currentBytes + len > MAX_BYTES) rotate();
    fs.appendFileSync(logFile, line);
    currentBytes += len;
  } catch {
    /* disk full / locked file — drop the line rather than crash */
  }
}

/** Install the console tee + crash handlers. Idempotent and fully defensive:
 *  any failure here leaves the app running with plain console logging. */
export function initLogging(): void {
  if (initialized) return;
  logDir = resolveLogDir();
  if (!logDir) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'main.log');
    currentBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  } catch {
    return;
  }
  initialized = true;

  const tee = (level: string, orig: (...a: any[]) => void) => (...args: any[]) => {
    writeLine(level, args);
    orig(...args);
  };
  console.log = tee('INFO', console.log.bind(console));
  console.info = tee('INFO', console.info.bind(console));
  console.warn = tee('WARN', console.warn.bind(console));
  console.error = tee('ERROR', console.error.bind(console));

  process.on('uncaughtException', (err: any) => writeLine('FATAL', [err?.stack || String(err)]));
  process.on('unhandledRejection', (reason: any) => writeLine('FATAL', ['unhandledRejection:', reason]));

  console.log(
    `[LOG] File logging started → ${logFile} ` +
      `(rolling, max ${MAX_FILES}×${Math.round(MAX_BYTES / 1024 / 1024)}MB)`,
  );
}

export function getLogDir(): string {
  return logDir;
}
