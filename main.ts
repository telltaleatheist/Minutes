const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
import { scanAudioSources, finalizeFileSet, finalizeFileSets, processDroppedFiles } from './src/audio-organizer';
import * as componentManager from './src/components/component-manager';
import { profile as detectSystemProfile } from './src/components/system-probe';
import * as llamaRuntime from './src/llama-runtime';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

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
  // In development, utilities are in the project root
  // In production (packaged), they're in resources/utilities
  const devPath = path.join(__dirname, '..', 'utilities');
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

function getWhisperPath() {
  // Prefer the component-managed download (macOS gets it on first run).
  const managed = componentManager.resolveEntry('whisper');
  if (managed) return managed;
  if (process.platform === 'win32') {
    // Windows ships a bundled whisper-cli.exe under utilities/bin.
    const utilitiesPath = getUtilitiesPath();
    return path.join(utilitiesPath, 'bin', 'whisper-cli.exe');
  }
  // Last resort on macOS/Linux: a system whisper.cpp CLI (Homebrew installs both names).
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

// Helper function to find RODECaster drive
function findRodecasterDrive() {
  const possibleDrives = ['G:', 'D:', 'F:', 'E:'];

  for (const drive of possibleDrives) {
    // Check if drive exists and has RODECaster-style folders (e.g., "168 - 16 Jan 2026")
    const drivePath = drive + '\\';
    try {
      if (fs.existsSync(drivePath)) {
        const items = fs.readdirSync(drivePath);
        // Look for RODECaster folder pattern or RODECaster subfolder
        const hasRodecasterFolders = items.some(item => {
          return /^\d+ - \d+ \w+ \d{4}$/.test(item) || item === 'RODECaster';
        });
        if (hasRodecasterFolders) {
          // Check if it's in a RODECaster subfolder or at root
          const subfolderPath = path.join(drivePath, 'RODECaster');
          if (fs.existsSync(subfolderPath)) {
            return subfolderPath;
          }
          return drivePath;
        }
      }
    } catch (e) {
      // Drive not accessible
    }
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
    // Default to G: drive where RODECaster files are
    const gDrive = 'G:\\';
    if (fs.existsSync(gDrive)) {
      dialogOptions.defaultPath = gDrive;
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

ipcMain.handle('transcribe-audio', async (event, audioPath, modelName = 'base') => {
  const whisperPathPre = getWhisperPath();
  const downloadedModelPre = componentManager.resolveEntry(`whisper-${modelName}`);
  const modelPathPre = downloadedModelPre || path.join(getWhisperModelsPath(), `ggml-${modelName}.bin`);
  if (process.platform !== 'win32' && !fs.existsSync(whisperPathPre)) {
    throw new Error(
      `Whisper engine not found. Download it from the setup screen (or install whisper.cpp with "brew install whisper-cpp").`
    );
  }
  if (!fs.existsSync(modelPathPre)) {
    throw new Error(`Whisper model not found at ${modelPathPre}. Download a model from the setup screen.`);
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
    const whisperPath = getWhisperPath();
    // Prefer a model installed via the setup screen (userData/components),
    // falling back to a model bundled in utilities/models.
    const downloadedModel = componentManager.resolveEntry(`whisper-${modelName}`);
    const modelPath = downloadedModel || path.join(getWhisperModelsPath(), `ggml-${modelName}.bin`);

    if (!fs.existsSync(whisperPath)) {
      reject(new Error(`Whisper binary not found at ${whisperPath}`));
      return;
    }

    if (!fs.existsSync(modelPath)) {
      reject(new Error(`Whisper model not found at ${modelPath}`));
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
      '-ng',             // No GPU - use CPU only
    ];

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
        reject(new Error(`Whisper exited with code ${code}: ${stderrTail}`));
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

ipcMain.handle('generate-meeting-notes', async (event, transcript, config) => {
  const { provider, model, localModel, ollamaHost } = config;

  const systemPrompt = `You are an expert meeting note taker.
Your task is to create clear, organized, and comprehensive meeting notes from the provided transcript.

FORMAT FOR EMAIL: The notes should be formatted for easy copying into an email. Use:
- Clear section headers in ALL CAPS or with emphasis markers
- Bullet points (•) for lists
- Indentation for sub-items
- Blank lines between sections for readability

Include these sections:
1. MEETING SUMMARY - A brief 2-3 sentence overview of the meeting
2. KEY DISCUSSION POINTS - Major topics discussed, organized by theme
3. ACTION ITEMS - Any tasks or commitments made, with assignees if mentioned
4. DECISIONS MADE - Any formal decisions or votes
5. FOLLOW-UP ITEMS - Topics to be revisited in future meetings

IMPORTANT: Do NOT include an "Attendees" section - the audio transcript cannot reliably identify who is speaking.

Be thorough but concise. Use bullet points for clarity.
If something is unclear in the transcript, note it as "[unclear]" rather than guessing.`;

  const userPrompt = `Please create comprehensive meeting notes from the following meeting transcript:\n\n${transcript}`;

  try {
    if (provider === 'local' || !provider) {
      return await generateWithLocal(userPrompt, systemPrompt, localModel);
    } else if (provider === 'ollama') {
      return await generateWithOllama(userPrompt, systemPrompt, model, ollamaHost);
    } else if (provider === 'claude') {
      return await generateWithClaude(userPrompt, systemPrompt, model);
    } else if (provider === 'openai') {
      return await generateWithOpenAI(userPrompt, systemPrompt, model);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
  } catch (error) {
    console.error('Error generating meeting notes:', error);
    throw error;
  }
});

async function generateWithLocal(prompt, systemPrompt, modelId) {
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

  console.log(`[AI] Generating with local engine: ${resolvedId}`);

  const { text } = await llamaRuntime.chat(resolvedId, systemPrompt, prompt, {
    maxTokens: 4000,
    temperature: 0.7,
  });

  return {
    success: true,
    notes: text,
    provider: 'local',
    model: resolvedId,
  };
}

async function generateWithOllama(prompt, systemPrompt, model, host) {
  const axios = require('axios');
  const ollamaHost = host || 'http://127.0.0.1:11434';

  console.log(`[AI] Generating with Ollama: ${model}`);

  const response = await axios.post(`${ollamaHost}/api/generate`, {
    model: model,
    prompt: `${systemPrompt}\n\n${prompt}`,
    stream: false,
    options: {
      temperature: 0.7,
      num_predict: 4000
    }
  }, { timeout: 600000 }); // 10 minute timeout

  return {
    success: true,
    notes: response.data.response,
    provider: 'ollama',
    model: model
  };
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
