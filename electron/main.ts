const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
import { scanAudioSources, finalizeFileSet, finalizeFileSets, processDroppedFiles } from './audio-organizer';
import * as componentManager from './components/component-manager';
import { profile as detectSystemProfile } from './components/system-probe';
import * as llamaRuntime from './llama-runtime';
import { synthesizeNotes } from './notes-synthesis';
import * as logger from './logger';

// Start file logging as early as possible so startup + crash output is captured.
logger.initLogging();

// Dev vs packaged: in dev we load the Angular dev server; packaged we load the
// built renderer bundle. (app.isPackaged is false when running `electron .`)
const isDev = !app.isPackaged;
const DEV_SERVER_URL = 'http://localhost:4250';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 933,
    height: 900,
    icon: path.join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);

  // Load the Angular renderer. Dev: the ng dev-server (HMR). Packaged: the
  // built bundle. @angular/build emits to dist/renderer/browser/index.html.
  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist', 'renderer', 'browser', 'index.html');
    mainWindow.loadFile(indexPath).catch((err) => {
      mainWindow?.loadURL(`data:text/html,<h2>Failed to load app</h2><pre>${String(err)}</pre>`);
    });
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Open DevTools if --dev-tools flag is passed
  if (process.argv.includes('--dev-tools')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Tear down the local AI server when the app exits so no orphan process lingers.
app.on('will-quit', () => {
  llamaRuntime.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getUtilitiesPath() {
  // In development, utilities are in the project root. __dirname is
  // dist/electron after compilation, so the project root is two levels up.
  // In production (packaged), they're in resources/utilities.
  const devPath = path.join(__dirname, '..', '..', 'utilities');
  const prodPath = path.join((process as any).resourcesPath || '', 'utilities');

  if (fs.existsSync(devPath)) {
    return devPath;
  }
  return prodPath;
}

// Resolve a system-installed CLI binary by name. GUI-launched apps on macOS get
// a minimal PATH that usually omits Homebrew, so check the common install dirs
// first and fall back to the bare name (resolved against PATH) as a last resort.
function resolveSystemBinary(...names: string[]): string {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/opt/local/bin'];
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return names[0]; // let the OS resolve it against PATH
}

function getWhisperPath(useGpu = false) {
  // GPU mode (Windows + NVIDIA): prefer the downloaded CUDA whisper build.
  if (useGpu) {
    const cuda = componentManager.resolveEntry('whisper-cuda');
    if (cuda) return cuda;
  }
  // The whisper engine is downloaded on first run (Windows + macOS) into
  // userData/components/. Prefer that; fall back to a system whisper.cpp CLI on
  // Linux or if the download is somehow missing (Homebrew installs both names).
  const managed = componentManager.resolveEntry('whisper');
  if (managed) return managed;
  return resolveSystemBinary('whisper-cli', 'whisper-cpp');
}

// Path to an ffmpeg binary used to normalize input to the 16 kHz mono WAV that
// whisper-cli expects (and to extract audio from video). Prefer the
// component-managed download (Windows + macOS); fall back to a system ffmpeg.
function getFfmpegPath() {
  return componentManager.resolveEntry('ffmpeg') || resolveSystemBinary('ffmpeg');
}

function getWhisperModelsPath() {
  const utilitiesPath = getUtilitiesPath();
  return path.join(utilitiesPath, 'models');
}

function getApiKeysPath() {
  return path.join(app.getPath('userData'), 'api-keys.json');
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// Does a directory look like a RODECaster card root? It either holds date-named
// session folders (e.g. "168 - 16 Jan 2026") or a "RODECaster" subfolder. Returns
// the recordings path to use (the subfolder if present, else the dir), or null.
function rodecasterRootIn(dir: string): string | null {
  try {
    if (!fs.existsSync(dir)) return null;
    const items = fs.readdirSync(dir);
    const looksLikeCard = items.some(
      (item) => /^\d+ - \d+ \w+ \d{4}$/.test(item) || item === 'RODECaster'
    );
    if (!looksLikeCard) return null;
    const subfolder = path.join(dir, 'RODECaster');
    return fs.existsSync(subfolder) ? subfolder : dir;
  } catch {
    return null; // not accessible
  }
}

// Locate a mounted RODECaster card across platforms. Windows: common removable
// drive letters. macOS: /Volumes/*. Linux: /media, /run/media, /mnt (one level).
function findRodecasterDrive(): string | null {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    for (const drive of ['G:', 'D:', 'F:', 'E:']) roots.push(drive + '\\');
  } else {
    const parents = process.platform === 'darwin'
      ? ['/Volumes']
      : ['/media', '/run/media', '/mnt'];
    for (const parent of parents) {
      try {
        for (const name of fs.readdirSync(parent)) roots.push(path.join(parent, name));
      } catch {
        // mount parent doesn't exist on this machine
      }
    }
  }
  for (const root of roots) {
    const hit = rodecasterRootIn(root);
    if (hit) return hit;
  }
  return null;
}

// ============================================================================
// IPC HANDLERS - FILE ORGANIZATION
// ============================================================================

// Get default directories
ipcMain.handle('get-default-directories', async () => {
  const rodecasterPath = findRodecasterDrive();
  const outputPath = path.join(app.getPath('documents'), 'Minutes Output');

  return {
    rodecaster: rodecasterPath,
    output: fs.existsSync(outputPath) ? outputPath : app.getPath('documents')
  };
});

// Select directory dialog
ipcMain.handle('select-directory', async (event, defaultPath) => {
  const dialogOptions: any = {
    properties: ['openDirectory']
  };

  if (defaultPath && fs.existsSync(defaultPath)) {
    dialogOptions.defaultPath = defaultPath;
  }

  const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('select-audio-file', async (event, defaultPath) => {
  const dialogOptions: any = {
    properties: ['openFile'],
    filters: [
      { name: 'Audio & Video', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'wma', 'mp4', 'mov', 'mkv', 'webm', 'avi'] },
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'wma'] },
      { name: 'Video Files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }
    ]
  };

  if (defaultPath && fs.existsSync(defaultPath)) {
    dialogOptions.defaultPath = defaultPath;
  } else {
    // Otherwise start in a mounted RODECaster card if one is present.
    const rodecaster = findRodecasterDrive();
    if (rodecaster) {
      dialogOptions.defaultPath = rodecaster;
    }
  }

  const result = await dialog.showOpenDialog(mainWindow, dialogOptions);
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});

// Scan audio sources
ipcMain.handle('scan-audio-sources', async (event, rodecasterDirectory, outputDirectory) => {
  try {
    const results = await scanAudioSources(rodecasterDirectory, outputDirectory);
    return results;
  } catch (error) {
    throw new Error(error.message);
  }
});

// Progress callback
function sendProgress(current, total, filename, action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('finalize-progress', {
      current,
      total,
      filename,
      action
    });
  }
}

// Finalize a single file set
ipcMain.handle('finalize-file-set', async (event, fileSet, outputDirectory) => {
  try {
    const result = await finalizeFileSet(fileSet, outputDirectory, sendProgress);
    return result;
  } catch (error) {
    throw new Error(error.message);
  }
});

// Finalize multiple file sets
ipcMain.handle('finalize-file-sets', async (event, fileSets, outputDirectory) => {
  try {
    const results = await finalizeFileSets(fileSets, outputDirectory, sendProgress);
    return results;
  } catch (error) {
    throw new Error(error.message);
  }
});

// Process dropped files
ipcMain.handle('process-dropped-files', async (event, paths, setName) => {
  try {
    const result = await processDroppedFiles(paths, setName);
    return result;
  } catch (error) {
    throw new Error(error.message);
  }
});

// ============================================================================
// IPC HANDLERS - API KEYS
// ============================================================================

ipcMain.handle('get-api-keys', async () => {
  try {
    const apiKeysPath = getApiKeysPath();

    if (!fs.existsSync(apiKeysPath)) {
      return { claudeApiKey: undefined, openaiApiKey: undefined };
    }

    const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));

    // Return masked keys for security
    return {
      claudeApiKey: data.claudeApiKey ? '***' : undefined,
      openaiApiKey: data.openaiApiKey ? '***' : undefined
    };
  } catch (error) {
    console.error('Error getting API keys:', error);
    return { claudeApiKey: undefined, openaiApiKey: undefined };
  }
});

ipcMain.handle('save-api-key', async (event, provider, apiKey) => {
  try {
    const apiKeysPath = getApiKeysPath();

    let existingKeys: any = {};
    if (fs.existsSync(apiKeysPath)) {
      existingKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
    }

    if (provider === 'claude') {
      existingKeys.claudeApiKey = apiKey;
    } else if (provider === 'openai') {
      existingKeys.openaiApiKey = apiKey;
    } else {
      return { success: false, error: 'Invalid provider' };
    }

    fs.writeFileSync(apiKeysPath, JSON.stringify(existingKeys, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('Error saving API key:', error);
    return { success: false, error: String(error) };
  }
});

// Get actual API key (for internal use)
function getApiKey(provider) {
  try {
    const apiKeysPath = getApiKeysPath();
    if (!fs.existsSync(apiKeysPath)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
    if (provider === 'claude') {
      return data.claudeApiKey;
    } else if (provider === 'openai') {
      return data.openaiApiKey;
    }
    return null;
  } catch (error) {
    return null;
  }
}

// ============================================================================
// IPC HANDLERS - CONFIG
// ============================================================================

ipcMain.handle('get-config', async () => {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      return {
        aiProvider: 'local',
        localAiModel: '',
        aiModel: '',
        ollamaHost: 'http://127.0.0.1:11434'
      };
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    return {
      aiProvider: 'local',
      localAiModel: '',
      aiModel: '',
      ollamaHost: 'http://127.0.0.1:11434'
    };
  }
});

ipcMain.handle('save-config', async (event, config) => {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

// Open the rolling log directory in the OS file manager (Settings → Diagnostics).
ipcMain.handle('open-logs-folder', async () => {
  const dir = logger.getLogDir();
  if (!dir) return { success: false, error: 'Logging is not initialized' };
  const err = await shell.openPath(dir);
  return err ? { success: false, error: err } : { success: true };
});

// ============================================================================
// IPC HANDLERS - OLLAMA
// ============================================================================

ipcMain.handle('check-ollama', async (event, host) => {
  const axios = require('axios');
  const ollamaHost = host || 'http://127.0.0.1:11434';

  try {
    const response = await axios.get(`${ollamaHost}/api/tags`, { timeout: 5000 });
    const models = response.data.models || [];
    return {
      connected: true,
      models: models.map(m => ({ id: m.name, name: m.name }))
    };
  } catch (error) {
    // Try 127.0.0.1 as fallback on Windows
    if (ollamaHost.includes('localhost')) {
      try {
        const fallbackHost = ollamaHost.replace('localhost', '127.0.0.1');
        const response = await axios.get(`${fallbackHost}/api/tags`, { timeout: 5000 });
        const models = response.data.models || [];
        return {
          connected: true,
          models: models.map(m => ({ id: m.name, name: m.name }))
        };
      } catch (e) {
        return { connected: false, models: [] };
      }
    }
    return { connected: false, models: [] };
  }
});

// ============================================================================
// IPC HANDLERS - WHISPER TRANSCRIPTION
// ============================================================================

// Read the duration (in seconds) of a WAV file from its header, without
// decoding the audio. whisper-cli only accepts WAV input, so this is reliable
// for every file we feed it. Returns null if the header can't be parsed, in
// which case progress falls back to whisper's own coarse "progress = N%".
function getWavDurationSeconds(filePath: string): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    // The fmt and data chunk markers live near the start of the file, even
    // with broadcast-wave metadata chunks (bext/iXML) ahead of the audio.
    const buf = Buffer.alloc(1024 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead < 12) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }

    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= bytesRead) {
      const chunkId = buf.toString('ascii', offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === 'fmt ') {
        // fmt: audioFormat(2) channels(2) sampleRate(4) byteRate(4) ...
        byteRate = buf.readUInt32LE(offset + 8 + 8);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
        break;
      }
      // Chunks are word-aligned: skip a pad byte when the size is odd.
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (byteRate > 0 && dataSize > 0) {
      return dataSize / byteRate;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// Parse the END time of the last "[hh:mm:ss.mmm --> hh:mm:ss.mmm]" segment
// stamp in a chunk of whisper output, returned in seconds. null if none.
function parseLatestSegmentEndSeconds(text: string): number | null {
  const re = /-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match;
  }
  if (!last) return null;
  const [, hh, mm, ss, ms] = last;
  return parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10) + parseInt(ms, 10) / 1000;
}

// Convert any input (compressed audio, video, non-16k WAV) to the 16 kHz mono
// PCM WAV that whisper-cli reliably reads. Rejects if ffmpeg can't be run.
function convertToWav(inputPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const args = ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath];
    const proc = spawn(ffmpegPath, args);
    let errTail = '';
    proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-4096); });
    proc.on('error', reject);
    proc.on('close', (code: number) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exited with code ${code}: ${errTail}`));
    });
  });
}

ipcMain.handle('transcribe-audio', async (event, audioPath, modelName = 'base', useGpu = false) => {
  // GPU transcription and the local AI engine both want VRAM, and the
  // llama-server stays resident (model + KV cache) between generations. Free it
  // before a GPU whisper run so Whisper isn't starved into a CUDA OOM.
  if (useGpu) llamaRuntime.stop();

  const whisperPathPre = getWhisperPath(useGpu);
  const downloadedModelPre = componentManager.resolveEntry(`whisper-${modelName}`);
  const modelPathPre = downloadedModelPre || path.join(getWhisperModelsPath(), `ggml-${modelName}.bin`);
  if (!fs.existsSync(whisperPathPre)) {
    throw new Error(
      `Transcription engine not found. Download it from the Downloads screen.`
    );
  }
  if (!fs.existsSync(modelPathPre)) {
    throw new Error(`Transcription model not found. Download one from the Downloads screen.`);
  }

  // Normalize the input to 16 kHz mono WAV before transcribing. If ffmpeg isn't
  // available we fall back to feeding the original file directly.
  const osMod = require('os');
  const convDir = path.join(osMod.tmpdir(), `boardnotes-conv-${Date.now()}`);
  fs.mkdirSync(convDir, { recursive: true });
  let preparedInput = audioPath;
  try {
    const wavInput = path.join(convDir, 'input.wav');
    await convertToWav(audioPath, wavInput);
    preparedInput = wavInput;
  } catch (e: any) {
    console.warn('[Whisper] ffmpeg conversion failed, using original file:', e?.message || e);
  }

  return new Promise((resolve, reject) => {
    const cleanupConv = () => { try { fs.rmSync(convDir, { recursive: true, force: true }); } catch { /* ignore */ } };
    audioPath = preparedInput;
    const whisperPath = getWhisperPath(useGpu);
    // Prefer a model installed via the setup screen (userData/components),
    // falling back to a model bundled in utilities/models.
    const downloadedModel = componentManager.resolveEntry(`whisper-${modelName}`);
    const modelPath = downloadedModel || path.join(getWhisperModelsPath(), `ggml-${modelName}.bin`);

    if (!fs.existsSync(whisperPath)) {
      reject(new Error(`Transcription engine not found at ${whisperPath}`));
      return;
    }

    if (!fs.existsSync(modelPath)) {
      reject(new Error(`Transcription model not found at ${modelPath}`));
      return;
    }

    // Output to temp directory
    const os = require('os');
    const outputDir = path.join(os.tmpdir(), `boardnotes-${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const basename = path.basename(audioPath, path.extname(audioPath));
    const outputBase = path.join(outputDir, basename);

    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-otxt',           // Output plain text
      '-of', outputBase, // Output file base
      '-pp',             // Print progress
    ];
    // CPU by default; pass GPU through only when the user opted in (requires a
    // GPU-capable whisper build — the CPU-only build ignores it and stays on CPU).
    if (!useGpu) args.push('-ng'); // -ng = no GPU

    console.log(`[Whisper] Starting transcription: ${audioPath}`);
    console.log(`[Whisper] Command: ${whisperPath} ${args.join(' ')}`);

    const totalSec = getWavDurationSeconds(audioPath);
    const startTime = Date.now();

    // The macOS whisper build ships its ggml/whisper dylibs next to the binary;
    // point the dynamic loader at that directory so they resolve regardless of cwd.
    const whisperEnv = process.platform === 'darwin'
      ? { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: [path.dirname(whisperPath), process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':') }
      : process.env;
    const proc = spawn(whisperPath, args, { cwd: outputDir, env: whisperEnv });

    // Keep only a bounded tail of stderr for error reporting (avoids the
    // O(n^2) accumulate-and-rematch on every chunk that the old code did).
    let stderrTail = '';
    let coarsePercent = 0;   // whisper's own "progress = N%", used as fallback
    let processedSec = 0;    // audio seconds transcribed so far (from segment stamps)

    // Emit current state to the renderer. Driven both by new output and by a
    // 1s heartbeat, so the elapsed clock and ETA always advance — the bar can
    // never silently "freeze" at 90%.
    const emitProgress = () => {
      const elapsedSec = (Date.now() - startTime) / 1000;
      let percent: number;
      let etaSec: number | null = null;
      if (totalSec && totalSec > 0 && processedSec > 0) {
        // Cap at 99 until the process actually exits; we send 100 on close.
        percent = Math.min(99, Math.round((processedSec / totalSec) * 100));
        const rate = processedSec / elapsedSec; // audio-sec per wall-sec
        if (rate > 0) etaSec = Math.max(0, (totalSec - processedSec) / rate);
      } else {
        percent = coarsePercent;
      }
      mainWindow?.webContents.send('transcription-progress', {
        percent,
        processedSec,
        totalSec: totalSec ?? null,
        elapsedSec,
        etaSec,
      });
    };

    const heartbeat = setInterval(emitProgress, 1000);

    const handleOutput = (chunk: string) => {
      const segEnd = parseLatestSegmentEndSeconds(chunk);
      if (segEnd !== null && segEnd > processedSec) {
        processedSec = segEnd;
      }
      const progressMatch = chunk.match(/progress\s*=\s*(\d+)/i);
      if (progressMatch) {
        const p = parseInt(progressMatch[1], 10);
        if (p > coarsePercent) coarsePercent = p;
      }
      if (segEnd !== null || progressMatch) emitProgress();
    };

    proc.stdout?.on('data', (data) => handleOutput(data.toString()));

    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderrTail = (stderrTail + chunk).slice(-8192);
      handleOutput(chunk);
    });

    proc.on('close', (code) => {
      clearInterval(heartbeat);
      cleanupConv();
      if (code === 0) {
        mainWindow?.webContents.send('transcription-progress', {
          percent: 100,
          processedSec: totalSec ?? processedSec,
          totalSec: totalSec ?? null,
          elapsedSec: (Date.now() - startTime) / 1000,
          etaSec: 0,
        });
        const txtPath = `${outputBase}.txt`;
        if (fs.existsSync(txtPath)) {
          const transcript = fs.readFileSync(txtPath, 'utf-8');
          // Clean up
          try {
            fs.rmSync(outputDir, { recursive: true });
          } catch (e) {
            // Ignore cleanup errors
          }
          resolve({ success: true, transcript });
        } else {
          reject(new Error('Transcription output file not found'));
        }
      } else {
        reject(new Error(`Transcription engine exited with code ${code}: ${stderrTail}`));
      }
    });

    proc.on('error', (error) => {
      clearInterval(heartbeat);
      cleanupConv();
      reject(error);
    });
  });
});

// ============================================================================
// IPC HANDLERS - AI MEETING NOTES GENERATION
// ============================================================================

// Default system prompt for meeting-notes generation. The user can override it
// from the Settings page (persisted as config.notesPrompt). Mirrored in the
// renderer (src/app/core/models/types.ts DEFAULT_NOTES_PROMPT) so Settings can
// show and reset it — keep the two copies in sync.
const DEFAULT_NOTES_PROMPT = `You are an expert meeting-notes writer. You will be given notes already extracted from a meeting, organized by topic and pre-sorted into labeled parts (Summary, Key points, Open questions, Action items, Decisions). Combine them into a single, clear set of meeting minutes.

FORMAT FOR EMAIL: format for easy copying into an email — clear section headers, bullet points (•) for lists, indentation for sub-items, and a blank line between sections.

Structure the minutes as:
1. SUMMARY — a 2-4 sentence overview of the whole meeting
2. KEY DISCUSSION POINTS — the main topics discussed, organized by topic
3. ACTION ITEMS — consolidated across the meeting, with an owner only when the words name one; merge duplicates
4. DECISIONS MADE — only items the extracts explicitly labeled as "Decisions"
5. FOLLOW-UP ITEMS — open questions and things to revisit (draw these from the extracts' "Open questions")

Rules:
- Use only information present in the provided notes. Do not infer or invent.
- TRUST THE CLASSIFICATION. The extracts already sorted content into parts. Keep it sorted: something listed under "Key points" or "Open questions" is NOT a decision — never upgrade it. Route every extracted "Open questions" item to FOLLOW-UP ITEMS, not DECISIONS.
- DECISIONS MADE must contain ONLY items that appear under a "Decisions:" label in the extracts. Most meetings have very few, or none. If the extracts contain no decisions, omit DECISIONS MADE entirely. Never manufacture a decision out of discussion.
- A decision is a choice to act or a commitment the group settled on — NOT a clarification, a fact, a status update, or a goal someone floated. Keep those under KEY DISCUSSION POINTS.
- Do not list the same item under both DECISIONS MADE and FOLLOW-UP ITEMS. Each item belongs in exactly one place.
- PRESERVE each speaker's stance. If the notes say someone was not worried about something, keep it that way — never flip it into the opposite.
- An action item is a task someone committed to do. Do NOT list floated ideas ("consider…", "look into…", "we could…", "maybe…") as action items — those belong under KEY DISCUSSION POINTS or FOLLOW-UP ITEMS.
- The transcript does not identify speakers. Give an action item an owner only when the words explicitly name who is responsible ("Kevin will…", "Owen, can you…"). Never infer the speaker; a WRONG owner is worse than none, so if no name is clearly given, leave the item unattributed.
- Do not attribute a statement, opinion, or past action to a named person in SUMMARY or KEY DISCUSSION POINTS unless the notes clearly name who said it. Prefer neutral phrasing ("a member noted…", "someone reached out…"). A name appearing near a remark does not mean that person made it.
- Keep FOLLOW-UP ITEMS tight: merge questions that ask the same thing, and never list the same open question more than once.
- Omit any section that has no content — do not write "None".
- Do not include an "Attendees" section.
- Output only the meeting notes — no preamble or commentary (e.g. do not begin with "Here are the notes").`;

ipcMain.handle('generate-meeting-notes', async (event, transcript, config) => {
  const { provider, model, localModel, ollamaHost, systemPrompt: customPrompt, useGpu, participants } = config;

  ollamaCtxFloor = 0; // reset the per-run Ollama context high-water mark
  ollamaNumGpu = undefined; // re-decide GPU layer placement for this run

  // Split the roster on commas / newlines / semicolons into clean names.
  const roster: string[] = String(participants || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // The user's saved prompt (else the built-in default) is the per-topic
  // meeting-notes generator. The topic-finding/orchestration prompts live in
  // notes-synthesis.ts and are never user-facing.
  const notesPrompt = (customPrompt && String(customPrompt).trim()) || DEFAULT_NOTES_PROMPT;

  // Route one (systemPrompt, userPrompt) call to the active provider and return
  // its text. Shared by every pass of the synthesis protocol.
  const callModel = async (sys: string, user: string): Promise<string> => {
    if (provider === 'local' || !provider) return (await generateWithLocal(user, sys, localModel, useGpu)).notes;
    if (provider === 'ollama') return (await generateWithOllama(user, sys, model, ollamaHost)).notes;
    if (provider === 'claude') return (await generateWithClaude(user, sys, model)).notes;
    if (provider === 'openai') return (await generateWithOpenAI(user, sys, model)).notes;
    throw new Error(`Unknown provider: ${provider}`);
  };

  const onProgress = (percent: number, message: string) => {
    mainWindow?.webContents.send('generation-progress', { percent, message });
  };

  try {
    const notes = await synthesizeNotes(transcript, notesPrompt, callModel, onProgress, roster);
    return { success: true, notes, provider: provider || 'local', model: localModel || model || '' };
  } catch (error) {
    console.error('Error generating meeting notes:', error);
    throw error;
  } finally {
    // Release the model once generation is done so it isn't left resident holding
    // VRAM/RAM. Cloud providers (claude/openai) have nothing local to free.
    if (provider === 'local' || !provider) {
      console.log('[AI] Generation finished — releasing local model from memory');
      llamaRuntime.stop();
    } else if (provider === 'ollama') {
      console.log('[AI] Generation finished — asking Ollama to unload the model');
      await unloadOllamaModel(model, ollamaHost).catch((e) =>
        console.warn('[AI] Ollama unload failed:', e?.message || e),
      );
    }
  }
});

// Per-run high-water mark for the Ollama context window. Kept module-level (only
// one generation runs at a time) and reset at the start of each generation so a
// large run doesn't pin a big context for the next one.
let ollamaCtxFloor = 0;
// Per-run GPU layer count for Ollama. `undefined` = not yet decided; `null` = let
// Ollama auto-place; a number = force that many layers onto the GPU. Only ever
// decreases within a run (the retry-on-OOM loop pushes more layers to the CPU).
let ollamaNumGpu: number | null | undefined;

/** Rough parameter count (billions) parsed from a model name/tag: "cogito:32b" → 32. */
function modelParamsB(name) {
  const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(String(name || ''));
  return m ? parseFloat(m[1]) : null;
}

/** Rough transformer layer count from parameter size, for GPU-offload planning. */
function layersForParams(b) {
  if (b <= 4) return 28;
  if (b <= 9) return 32;
  if (b <= 15) return 48;
  if (b <= 35) return 64;
  if (b <= 80) return 80;
  return 96;
}

/**
 * Automatic memory plan for an Ollama run. The hard constraint on a GPU is that
 * weights + KV cache + compute all share VRAM — counting system RAM as if it
 * helps is wrong. So we budget VRAM explicitly: reserve room for the desktop and
 * compute, size the KV cache for the chosen context, and if the full weights then
 * don't fit, tell Ollama to offload just enough layers to the CPU (`num_gpu`) so
 * it fits instead of crashing. A few CPU layers = a bit slower, never an OOM.
 * Returns { numCtx, numGpu } — numGpu null means "let Ollama decide" (fits fully).
 */
function planOllamaMemory(prof, modelName, neededCtx) {
  const b = modelParamsB(modelName);
  const vramGB = (prof?.cuda?.vramMB || 0) / 1024;
  const numCtx = Math.min(neededCtx, 16384);
  if (b == null || vramGB <= 0) return { numCtx, numGpu: null }; // unknown → don't micromanage

  const weightsGB = b * 0.6;             // Q4 weights
  const kvMBPerTok = 0.008 * b;          // ~0.25 MB/token for a 32B GQA model
  const kvGB = (numCtx * kvMBPerTok) / 1024;
  const effectiveVram = Math.max(0, vramGB - 3); // reserve ~3 GB for desktop / other apps
  const gpuWeightBudget = effectiveVram - kvGB - 2; // ~2 GB compute buffer

  // This is only a STARTING estimate — generateWithOllama retries with fewer GPU
  // layers if it turns out to be too optimistic, so we don't over-offload here.
  let numGpu = null;
  if (gpuWeightBudget >= weightsGB) {
    numGpu = null; // all layers fit on the GPU alongside the KV cache
  } else if (gpuWeightBudget > 0) {
    const total = layersForParams(b);
    numGpu = Math.max(0, Math.floor((gpuWeightBudget / weightsGB) * total) - 1); // -1 safety
  } else {
    numGpu = 0; // weights alone don't fit → run on CPU (slow but won't crash)
  }
  return { numCtx, numGpu };
}

/** Tell Ollama to unload a model from memory immediately (keep_alive: 0). */
async function unloadOllamaModel(model, host) {
  if (!model) return;
  const axios = require('axios');
  const ollamaHost = host || 'http://127.0.0.1:11434';
  await axios.post(`${ollamaHost}/api/generate`, { model, keep_alive: 0 }, { timeout: 15000 });
}

async function generateWithLocal(prompt, systemPrompt, modelId, useGpu = false) {
  // Fall back to the first installed local model if none was explicitly chosen.
  let resolvedId = modelId;
  if (!resolvedId) {
    const statuses = await componentManager.listStatus();
    const firstAi = statuses.find(s => s.component.category === 'ai' && s.state === 'installed');
    if (firstAi) resolvedId = firstAi.component.id;
  }
  if (!resolvedId) {
    throw new Error('No local AI model is installed. Download one in setup first.');
  }

  console.log(`[AI] Generating with local engine: ${resolvedId} (${useGpu ? 'GPU' : 'CPU'})`);

  const { text } = await llamaRuntime.chat(resolvedId, systemPrompt, prompt, {
    maxTokens: 4000,
    temperature: 0.7,
    preferCpu: !useGpu,
  });

  return {
    success: true,
    notes: text,
    provider: 'local',
    model: resolvedId,
  };
}

function isOllamaMemoryError(detail: string): boolean {
  return /bad_alloc|out of memory|cudamalloc|failed to allocate|insufficient|ggml_assert|mem_buffer|has terminated|0xc000|stack-based buffer/i.test(
    detail,
  );
}

/** Log what Ollama actually placed where (GPU vs CPU) — the measured reality, not our estimate. */
async function logOllamaPlacement(host: string, model: string): Promise<void> {
  try {
    const axios = require('axios');
    const r = await axios.get(`${host}/api/ps`, { timeout: 5000 });
    const m = (r.data?.models || []).find((x: any) => x.name === model || x.model === model);
    if (m && m.size) {
      const pct = Math.round((m.size_vram / m.size) * 100);
      console.log(
        `[AI] Ollama placement: ${model} ${(m.size / 1e9).toFixed(1)}GB total, ${(m.size_vram / 1e9).toFixed(1)}GB in VRAM (${pct}% on GPU)`,
      );
    }
  } catch {
    /* /api/ps is best-effort visibility only */
  }
}

async function generateWithOllama(prompt, systemPrompt, model, host) {
  const axios = require('axios');
  const ollamaHost = host || 'http://127.0.0.1:11434';

  // Size context to the prompt's actual need (else Ollama uses the full trained
  // context, e.g. 32k), but never shrink within a run — Ollama reloads on any
  // num_ctx change, so use a per-run high-water mark.
  const prof = await detectSystemProfile().catch(() => null);
  const need = llamaRuntime.estimateCtxSize(systemPrompt, prompt, 4000);
  ollamaCtxFloor = Math.max(ollamaCtxFloor, Math.min(need, 16384));
  const numCtx = ollamaCtxFloor;

  // Initialise the per-run GPU layer count from an estimate the first time, then
  // let the retry loop below correct it downward if reality disagrees.
  const b = modelParamsB(model);
  const totalLayers = b ? layersForParams(b) : 40;
  if (ollamaNumGpu === undefined) ollamaNumGpu = planOllamaMemory(prof, model, numCtx).numGpu;

  const body = `${systemPrompt}\n\n${prompt}`;
  for (;;) {
    const options: Record<string, number> = { temperature: 0.7, num_predict: 4000, num_ctx: numCtx };
    if (ollamaNumGpu != null) options.num_gpu = ollamaNumGpu;
    console.log(`[AI] Generating with Ollama: ${model} (num_ctx=${numCtx}, num_gpu=${ollamaNumGpu ?? 'auto'})`);
    try {
      const response = await axios.post(
        `${ollamaHost}/api/generate`,
        { model, prompt: body, stream: false, options },
        { timeout: 600000 },
      );
      await logOllamaPlacement(ollamaHost, model);
      return { success: true, notes: response.data.response, provider: 'ollama', model };
    } catch (err) {
      const detail = err?.response?.data?.error || err?.message || String(err);
      if (!isOllamaMemoryError(detail)) throw new Error(`Ollama request failed: ${detail}`);

      // Out of memory: pull more layers onto the CPU and retry. Self-corrects for
      // bad estimates / parallel KV slots without crashing the whole generation.
      const current = ollamaNumGpu == null ? totalLayers : ollamaNumGpu;
      if (current > 0) {
        ollamaNumGpu = Math.max(0, Math.floor(current * 0.6) - 1);
        console.warn(`[AI] Ollama out of memory — retrying with fewer GPU layers (num_gpu=${ollamaNumGpu})`);
        continue;
      }
      // Already CPU-only and still failing → genuinely can't fit.
      throw new Error(
        `Ollama ran out of memory running "${model}", even with the model on the CPU. It's too large for this machine's RAM. Use a smaller model, or increase your Windows page file size (System → Advanced → Performance → Virtual memory).`,
      );
    }
  }
}

async function generateWithClaude(prompt, systemPrompt, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = getApiKey('claude');

  if (!apiKey) {
    throw new Error('Claude API key not configured');
  }

  console.log(`[AI] Generating with Claude: ${model}`);

  const anthropic = new Anthropic({ apiKey });

  // Map friendly names to actual model names
  const modelMap = {
    'claude-sonnet-4': 'claude-sonnet-4-5-20250929',
    'claude-3-5-sonnet': 'claude-sonnet-4-5-20250929',
    'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
    'claude-3-haiku': 'claude-3-haiku-20240307',
    'claude-3-opus': 'claude-opus-4-5-20251101'
  };
  const actualModel = modelMap[model] || model;

  const response = await anthropic.messages.create({
    model: actualModel,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7
  });

  const textBlock = response.content.find(block => block.type === 'text');

  return {
    success: true,
    notes: textBlock?.text || '',
    provider: 'claude',
    model: actualModel
  };
}

async function generateWithOpenAI(prompt, systemPrompt, model) {
  const OpenAI = require('openai');
  const apiKey = getApiKey('openai');

  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  console.log(`[AI] Generating with OpenAI: ${model}`);

  const openai = new OpenAI({ apiKey });

  const response = await openai.chat.completions.create({
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ],
    max_tokens: 4000,
    temperature: 0.7
  });

  return {
    success: true,
    notes: response.choices[0]?.message?.content || '',
    provider: 'openai',
    model: model
  };
}

// ============================================================================
// IPC HANDLERS - MISC
// ============================================================================

ipcMain.handle('open-folder', async (event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
    return { success: true };
  }
  return { success: false, error: 'Folder does not exist' };
});

ipcMain.handle('save-notes', async (event, notes, outputPath) => {
  try {
    fs.writeFileSync(outputPath, notes, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});

// ============================================================================
// IPC HANDLERS - COMPONENTS (download/setup)
// ============================================================================

// Detected machine capabilities (platform, RAM, CUDA, free disk).
ipcMain.handle('detect-system', async () => {
  return detectSystemProfile();
});

// Catalog × installed × compatibility for every component.
ipcMain.handle('list-components', async () => {
  return componentManager.listStatus();
});

// Download + verify + install a component, streaming progress to the renderer.
ipcMain.handle('install-component', async (event, id) => {
  return componentManager.install(id, (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('component-progress', p);
    }
  });
});

// Abort an in-flight install.
ipcMain.handle('cancel-install', async (event, id) => {
  componentManager.cancel(id);
  return { success: true };
});

// Remove an installed component.
ipcMain.handle('uninstall-component', async (event, id) => {
  try {
    await componentManager.uninstall(id);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});
