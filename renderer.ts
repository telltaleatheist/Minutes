// @ts-nocheck
// ============================================================================
// BOARDNOTES - RENDERER
// ============================================================================
// NOTE: @ts-nocheck is transitional. This legacy DOM code compiles as-is under
// tsc; new UI (the setup wizard) will be written as properly typed TS and this
// directive removed file-by-file as the old code is replaced.

// State
let rodecasterDirectory = '';
let outputDirectory = '';
let fileSets = [];
let transcript = '';
let meetingNotes = '';
let currentAudioPath = '';

// Config
let config = {
  aiProvider: 'ollama',
  aiModel: 'cogito:32b',
  ollamaHost: 'http://127.0.0.1:11434',
  whisperModel: 'small'
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Load theme
  const savedTheme = localStorage.getItem('boardnotes-theme') || 'dark';
  document.body.setAttribute('data-theme', savedTheme);

  // Load default output directory (used when saving notes)
  const dirs = await window.electronAPI.getDefaultDirectories();
  if (dirs.rodecaster) {
    rodecasterDirectory = dirs.rodecaster;
  }
  if (dirs.output) {
    outputDirectory = dirs.output;
  }

  // Load config
  const savedConfig = await window.electronAPI.getConfig();
  config = { ...config, ...savedConfig };
  applyConfig();

  // Load API keys status
  await checkApiKeys();

  // Setup event listeners
  setupEventListeners();
  setupProgressListeners();
});

function applyConfig() {
  document.getElementById('ai-provider').value = config.aiProvider;
  document.getElementById('ai-model').value = config.aiModel;
  document.getElementById('ollama-host').value = config.ollamaHost || 'http://127.0.0.1:11434';
  document.getElementById('whisper-model').value = config.whisperModel || 'base';

  // Show/hide Ollama host based on provider
  updateProviderUI();
}

async function checkApiKeys() {
  const keys = await window.electronAPI.getApiKeys();

  if (keys.claudeApiKey) {
    document.getElementById('claude-key-status').textContent = 'Configured';
    document.getElementById('claude-key-status').style.color = 'var(--success)';
  }

  if (keys.openaiApiKey) {
    document.getElementById('openai-key-status').textContent = 'Configured';
    document.getElementById('openai-key-status').style.color = 'var(--success)';
  }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Settings button
  document.getElementById('settings-btn').addEventListener('click', () => {
    switchTab('settings');
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // File loading: drop zone + picker
  setupDropZone();

  // Processing
  document.getElementById('transcribe-btn').addEventListener('click', transcribeAudio);
  document.getElementById('generate-btn').addEventListener('click', generateNotes);
  document.getElementById('save-btn').addEventListener('click', saveNotes);

  // Copy buttons
  document.getElementById('copy-transcript').addEventListener('click', () => copyToClipboard(transcript, 'Transcript'));
  document.getElementById('copy-notes').addEventListener('click', () => copyToClipboard(meetingNotes, 'Notes'));

  // Settings
  document.getElementById('ai-provider').addEventListener('change', updateProviderUI);
  document.getElementById('check-ollama').addEventListener('click', checkOllama);
  document.getElementById('save-claude-key').addEventListener('click', () => saveApiKey('claude'));
  document.getElementById('save-openai-key').addEventListener('click', () => saveApiKey('openai'));
  document.getElementById('save-settings').addEventListener('click', saveSettings);

  // Modal
  document.getElementById('confirm-cancel').addEventListener('click', hideModal);
}

function setupProgressListeners() {
  window.electronAPI.onProgress((data) => {
    updateProgress(data.current, data.total, data.filename, data.action);
  });

  window.electronAPI.onTranscriptionProgress((data) => {
    updateTranscriptionProgress(data);
  });
}

// Format a duration in seconds as H:MM:SS (or M:SS when under an hour).
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// Render real transcription progress: a moving bar, an elapsed/total clock,
// and a live ETA. The clock updates every second via the main-process
// heartbeat, so the user can always tell it's still working.
function updateTranscriptionProgress(data) {
  const percent = Math.max(0, Math.min(100, Math.round(data.percent || 0)));
  document.getElementById('progress-fill').style.width = `${percent}%`;
  document.getElementById('progress-percent').textContent = `${percent}%`;

  let status;
  if (data.totalSec && data.processedSec) {
    status = `Transcribing ${formatClock(data.processedSec)} / ${formatClock(data.totalSec)}`;
    if (data.etaSec != null && percent < 100) {
      status += ` · ~${formatClock(data.etaSec)} left`;
    }
  } else if (data.elapsedSec) {
    // Duration unknown — still show liveness via the elapsed clock.
    status = `Transcribing · ${formatClock(data.elapsedSec)} elapsed`;
  } else {
    status = 'Loading Whisper model...';
  }
  document.getElementById('progress-status').textContent = status;
}

// ============================================================================
// THEME
// ============================================================================

function toggleTheme() {
  const currentTheme = document.body.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', newTheme);
  localStorage.setItem('boardnotes-theme', newTheme);
}

// ============================================================================
// TABS
// ============================================================================

function switchTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.add('hidden');
  });
  document.getElementById(`${tabName}-tab`).classList.remove('hidden');
}

// ============================================================================
// FILE LOADING (DROP ZONE + PICKER)
// ============================================================================

function setupDropZone() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  // Click to browse
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadFile(file.path);
    fileInput.value = ''; // allow re-selecting the same file
  });

  // Drag & drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  ['dragleave', 'dragend'].forEach((evt) =>
    dropZone.addEventListener(evt, () => dropZone.classList.remove('dragover'))
  );
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.path) loadFile(file.path);
  });

  // Prevent the window from navigating when a file is dropped outside the zone
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

// Load a file and get the Generate Notes flow ready
function loadFile(filePath) {
  currentAudioPath = filePath;
  const fileName = filePath.split(/[\\/]/).pop();

  resetProcessState();
  setDropZoneFile(fileName);
  document.getElementById('transcribe-btn').disabled = false;

  showToast('success', 'File Loaded', `Ready to transcribe: ${fileName}`);
}

// Show the loaded file inside the drop zone
function setDropZoneFile(fileName) {
  document.getElementById('drop-zone').innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
    <h3>${fileName}</h3>
    <p>Click or drop to choose a different file</p>
  `;
}

// Clear transcript/notes from any previous run when a new file is loaded
function resetProcessState() {
  transcript = '';
  meetingNotes = '';
  document.getElementById('transcript-output').innerHTML =
    '<p class="text-tertiary">Transcript will appear here after transcription...</p>';
  document.getElementById('notes-output').innerHTML =
    '<p class="text-tertiary">Meeting notes will appear here after generation...</p>';
  document.getElementById('copy-transcript').disabled = true;
  document.getElementById('copy-notes').disabled = true;
  document.getElementById('generate-btn').disabled = true;
  document.getElementById('save-btn').disabled = true;
  setStepActive(0);
}

// ============================================================================
// FILE SCANNING
// ============================================================================

async function scanSources() {
  if (!rodecasterDirectory) {
    showToast('error', 'Error', 'Please select a RODECaster directory');
    return;
  }

  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';

  try {
    const result = await window.electronAPI.scanAudioSources(rodecasterDirectory, outputDirectory);
    fileSets = result.fileSets;
    renderFileSets();

    if (fileSets.length === 0) {
      showToast('info', 'No Files', 'No audio files found in the selected directory');
    } else {
      showToast('success', 'Scan Complete', `Found ${fileSets.length} recording(s)`);
    }
  } catch (error) {
    showToast('error', 'Scan Failed', error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Scan Sources';
  }
}

// ============================================================================
// RENDER FILE SETS
// ============================================================================

function renderFileSets() {
  const container = document.getElementById('file-sets-container');

  if (fileSets.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <h3>No Audio Files Found</h3>
        <p>Select your RODECaster directory and click "Scan Sources" to find board meeting recordings.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = fileSets.map((set, index) => `
    <div class="file-set" data-index="${index}">
      <div class="file-set-header">
        <div class="file-set-title">
          <span class="file-set-name">${set.name}</span>
          <span class="file-set-duration">${set.durationFormatted}</span>
        </div>
      </div>
      <div class="file-set-body">
        <div class="file-list">
          ${set.audioFiles.map(file => renderFileItem(file)).join('')}
        </div>
      </div>
    </div>
  `).join('');
}

function renderFileItem(file) {
  return `
    <div class="file-item" data-id="${file.id}">
      <div class="file-info">
        <div class="file-new-name">${file.baseName}</div>
        <div class="file-original-name">${file.originalName}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="generateNotesForFile('${file.fullPath.replace(/\\/g, '\\\\')}', '${file.baseName}')">Generate Notes</button>
    </div>
  `;
}

function onFileCheckChange(e) {
  const fileId = e.target.dataset.id;
  const fileItem = e.target.closest('.file-item');

  // Update state
  for (const set of fileSets) {
    const file = set.audioFiles.find(f => f.id === fileId);
    if (file) {
      file.checked = e.target.checked;
      break;
    }
  }

  // Update UI
  fileItem.classList.toggle('checked', e.target.checked);
}

// ============================================================================
// FINALIZATION
// ============================================================================

async function finalizeSet(index) {
  console.log('finalizeSet called with index:', index);

  const fileSet = fileSets[index];
  if (!fileSet) {
    showToast('error', 'Error', 'File set not found');
    return;
  }

  const checkedFiles = fileSet.audioFiles.filter(f => f.checked);
  console.log('Checked files:', checkedFiles.length);

  if (checkedFiles.length === 0) {
    showToast('error', 'No Files', 'Please select at least one file to finalize');
    return;
  }

  if (!outputDirectory) {
    showToast('error', 'Error', 'Please select an output directory');
    return;
  }

  // Skip confirmation, just do it
  showProgress();
  try {
    const result = await window.electronAPI.finalizeFileSet(fileSet, outputDirectory);
    hideProgress();

    if (result.errors.length > 0) {
      showToast('warning', 'Completed with Errors', `${result.success.length} moved, ${result.errors.length} failed`);
    } else {
      showToast('success', 'Success', `${result.success.length} file(s) moved successfully`);
    }

    // Re-scan
    await scanSources();
    updateAudioFileSelect();
  } catch (error) {
    hideProgress();
    showToast('error', 'Error', error.message);
    console.error('Finalize error:', error);
  }
}

async function finalizeAll() {
  const setsWithFiles = fileSets.filter(set => set.audioFiles.some(f => f.checked));

  if (setsWithFiles.length === 0) {
    showToast('error', 'No Files', 'Please select at least one file to finalize');
    return;
  }

  if (!outputDirectory) {
    showToast('error', 'Error', 'Please select an output directory');
    return;
  }

  let totalFiles = 0;
  setsWithFiles.forEach(set => {
    totalFiles += set.audioFiles.filter(f => f.checked).length;
  });

  showConfirm(
    'Finalize All Sets',
    `Move ${totalFiles} file(s) from ${setsWithFiles.length} set(s)?`,
    async () => {
      showProgress();
      try {
        const results = await window.electronAPI.finalizeFileSets(setsWithFiles, outputDirectory);
        hideProgress();

        let totalSuccess = 0;
        let totalErrors = 0;
        results.forEach(r => {
          totalSuccess += r.success.length;
          totalErrors += r.errors.length;
        });

        if (totalErrors > 0) {
          showToast('warning', 'Completed with Errors', `${totalSuccess} moved, ${totalErrors} failed`);
        } else {
          showToast('success', 'Success', `${totalSuccess} file(s) moved successfully`);
        }

        // Re-scan
        await scanSources();
        updateAudioFileSelect();
      } catch (error) {
        hideProgress();
        showToast('error', 'Error', error.message);
      }
    }
  );
}

// ============================================================================
// AUDIO FILE SELECTION
// ============================================================================

function updateAudioFileSelect() {
  const select = document.getElementById('audio-file-select');
  select.innerHTML = '<option value="">-- Select an audio file --</option>';

  // Add finalized sets from output directory
  if (outputDirectory) {
    // We'll need to scan the output directory for wav files
    // For now, show a message
    select.innerHTML += '<option value="browse">Browse for audio file...</option>';
  }
}

function onAudioFileSelect(e) {
  const value = e.target.value;
  if (value === 'browse') {
    browseAudioFile();
  } else if (value) {
    currentAudioPath = value;
    document.getElementById('transcribe-btn').disabled = false;
  }
}

// ============================================================================
// TRANSCRIPTION
// ============================================================================

async function transcribeAudio() {
  if (!currentAudioPath) {
    showToast('error', 'Error', 'Please select an audio file first');
    return;
  }

  const btn = document.getElementById('transcribe-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Transcribing...';

  setStepActive(1);
  showProgress();
  // Real progress/ETA arrives via onTranscriptionProgress (driven by whisper's
  // segment timestamps plus a 1s heartbeat from the main process).
  updateTranscriptionProgress({ percent: 0 });

  try {
    const result = await window.electronAPI.transcribeAudio(currentAudioPath, config.whisperModel);
    updateTranscriptionProgress({ percent: 100, totalSec: 1, processedSec: 1, etaSec: 0 });

    transcript = result.transcript;

    document.getElementById('transcript-output').textContent = transcript;
    document.getElementById('copy-transcript').disabled = false;

    setStepCompleted(1);
    document.getElementById('generate-btn').disabled = false;

    showToast('success', 'Transcription Complete', 'Audio has been transcribed successfully');
  } catch (error) {
    showToast('error', 'Transcription Failed', error.message);
    setStepActive(0);
  } finally {
    setTimeout(() => hideProgress(), 1000);
    btn.disabled = false;
    btn.innerHTML = 'Transcribe';
  }
}

// ============================================================================
// MEETING NOTES GENERATION
// ============================================================================

async function generateNotes() {
  if (!transcript) {
    showToast('error', 'Error', 'Please transcribe audio first');
    return;
  }

  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating...';

  setStepActive(2);
  showProgress();
  updateProgress(0, 100, 'Connecting to AI...', 'AI');

  // Start animated progress for AI generation
  let fakeProgress = 0;
  const progressMessages = [
    'Connecting to AI...',
    'Analyzing transcript...',
    'Identifying key topics...',
    'Extracting action items...',
    'Formatting meeting notes...',
    'Finalizing notes...'
  ];
  let messageIndex = 0;

  const progressInterval = setInterval(() => {
    if (fakeProgress < 90) {
      fakeProgress += Math.random() * 3;
      // Cycle through progress messages
      if (fakeProgress > (messageIndex + 1) * 15 && messageIndex < progressMessages.length - 1) {
        messageIndex++;
      }
      updateProgress(Math.min(fakeProgress, 90), 100, progressMessages[messageIndex], 'AI');
    }
  }, 400);

  try {
    const result = await window.electronAPI.generateMeetingNotes(transcript, {
      provider: config.aiProvider,
      model: config.aiModel,
      ollamaHost: config.ollamaHost
    });

    clearInterval(progressInterval);
    updateProgress(100, 100, 'Notes generated!', 'AI');

    meetingNotes = result.notes;

    document.getElementById('notes-output').textContent = meetingNotes;
    document.getElementById('copy-notes').disabled = false;

    setStepCompleted(2);
    document.getElementById('save-btn').disabled = false;

    showToast('success', 'Generation Complete', `Notes generated using ${result.provider}/${result.model}`);
  } catch (error) {
    clearInterval(progressInterval);
    showToast('error', 'Generation Failed', error.message);
    setStepActive(1);
  } finally {
    setTimeout(() => hideProgress(), 1000);
    btn.disabled = false;
    btn.innerHTML = 'Generate';
  }
}

// ============================================================================
// SAVE NOTES
// ============================================================================

async function saveNotes() {
  if (!meetingNotes) {
    showToast('error', 'Error', 'No notes to save');
    return;
  }

  const date = new Date().toISOString().split('T')[0];
  const filename = `SSA Board Meeting Notes - ${date}.md`;
  const outputPath = `${outputDirectory}/${filename}`;

  try {
    const result = await window.electronAPI.saveNotes(meetingNotes, outputPath);
    if (result.success) {
      setStepCompleted(3);
      showToast('success', 'Saved', `Notes saved to ${filename}`);
      await window.electronAPI.openFolder(outputDirectory);
    } else {
      showToast('error', 'Save Failed', result.error);
    }
  } catch (error) {
    showToast('error', 'Save Failed', error.message);
  }
}

// ============================================================================
// PROCESSING STEPS UI
// ============================================================================

function setStepActive(stepNum) {
  for (let i = 1; i <= 3; i++) {
    const step = document.getElementById(`step-${i}`);
    step.classList.remove('active', 'completed');
    if (i === stepNum) {
      step.classList.add('active');
    } else if (i < stepNum) {
      step.classList.add('completed');
    }
  }
}

function setStepCompleted(stepNum) {
  const step = document.getElementById(`step-${stepNum}`);
  step.classList.remove('active');
  step.classList.add('completed');
}

// ============================================================================
// SETTINGS
// ============================================================================

// Cache for Ollama models
let cachedOllamaModels = [];

async function updateProviderUI() {
  const provider = document.getElementById('ai-provider').value;
  const ollamaHostGroup = document.getElementById('ollama-host-group');
  const modelSelect = document.getElementById('ai-model');

  // Show/hide Ollama host
  ollamaHostGroup.classList.toggle('hidden', provider !== 'ollama');

  // Static model lists for cloud providers
  const cloudModels = {
    claude: [
      { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (Recommended)' },
      { value: 'claude-3-haiku', label: 'Claude 3 Haiku (Fast)' },
      { value: 'claude-3-opus', label: 'Claude 3 Opus (Best)' }
    ],
    openai: [
      { value: 'gpt-4o', label: 'GPT-4o (Recommended)' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' }
    ]
  };

  if (provider === 'ollama') {
    // Fetch models from Ollama
    await refreshOllamaModels();
  } else {
    modelSelect.innerHTML = cloudModels[provider].map(m =>
      `<option value="${m.value}">${m.label}</option>`
    ).join('');
  }

  config.aiProvider = provider;
}

async function refreshOllamaModels() {
  const host = document.getElementById('ollama-host').value;
  const modelSelect = document.getElementById('ai-model');

  try {
    const result = await window.electronAPI.checkOllama(host);
    if (result.connected && result.models.length > 0) {
      cachedOllamaModels = result.models;
      modelSelect.innerHTML = result.models.map(m =>
        `<option value="${m.id}">${m.name}</option>`
      ).join('');
    } else {
      modelSelect.innerHTML = '<option value="">No models found - check Ollama connection</option>';
    }
  } catch (error) {
    modelSelect.innerHTML = '<option value="">Could not connect to Ollama</option>';
  }
}

async function checkOllama() {
  const host = document.getElementById('ollama-host').value;
  const btn = document.getElementById('check-ollama');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const result = await window.electronAPI.checkOllama(host);
    if (result.connected) {
      showToast('success', 'Connected', `Found ${result.models.length} model(s)`);
      // Refresh the model dropdown with the fetched models
      await refreshOllamaModels();
    } else {
      showToast('error', 'Not Connected', 'Could not connect to Ollama');
    }
  } catch (error) {
    showToast('error', 'Error', error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Check';
  }
}

async function saveApiKey(provider) {
  const inputId = provider === 'claude' ? 'claude-key' : 'openai-key';
  const statusId = provider === 'claude' ? 'claude-key-status' : 'openai-key-status';
  const apiKey = document.getElementById(inputId).value.trim();

  if (!apiKey) {
    showToast('error', 'Error', 'Please enter an API key');
    return;
  }

  try {
    const result = await window.electronAPI.saveApiKey(provider, apiKey);
    if (result.success) {
      document.getElementById(statusId).textContent = 'Configured';
      document.getElementById(statusId).style.color = 'var(--success)';
      document.getElementById(inputId).value = '';
      showToast('success', 'Saved', `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key saved`);
    } else {
      showToast('error', 'Error', result.error);
    }
  } catch (error) {
    showToast('error', 'Error', error.message);
  }
}

async function saveSettings() {
  config.aiProvider = document.getElementById('ai-provider').value;
  config.aiModel = document.getElementById('ai-model').value;
  config.ollamaHost = document.getElementById('ollama-host').value;
  config.whisperModel = document.getElementById('whisper-model').value;

  try {
    const result = await window.electronAPI.saveConfig(config);
    if (result.success) {
      showToast('success', 'Saved', 'Settings saved successfully');
    } else {
      showToast('error', 'Error', result.error);
    }
  } catch (error) {
    showToast('error', 'Error', error.message);
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function copyToClipboard(text, name) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('success', 'Copied', `${name} copied to clipboard`);
  }).catch(err => {
    showToast('error', 'Error', 'Failed to copy to clipboard');
  });
}

// ============================================================================
// PROGRESS
// ============================================================================

function showProgress() {
  document.getElementById('progress-container').classList.remove('hidden');
}

function hideProgress() {
  document.getElementById('progress-container').classList.add('hidden');
  document.getElementById('progress-fill').style.width = '0%';
}

function updateProgress(current, total, filename, action) {
  const percent = Math.round((current / total) * 100);
  document.getElementById('progress-fill').style.width = `${percent}%`;
  document.getElementById('progress-percent').textContent = `${percent}%`;
  document.getElementById('progress-status').textContent = `${action}: ${filename}`;
}

// ============================================================================
// TOAST
// ============================================================================

function showToast(type, title, message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-title">${title}</div>
    <div class="toast-message">${message}</div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 5000);
}

// ============================================================================
// MODAL
// ============================================================================

let confirmCallback = null;

function showConfirm(title, message, callback) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-modal').classList.add('show');
  confirmCallback = callback;

  document.getElementById('confirm-ok').onclick = () => {
    hideModal();
    if (confirmCallback) confirmCallback();
  };
}

function hideModal() {
  document.getElementById('confirm-modal').classList.remove('show');
  confirmCallback = null;
}

// Make functions available globally for onclick handlers
window.finalizeSet = finalizeSet;
window.generateNotesForFile = generateNotesForFile;

// Generate notes for a specific file - switches to Process tab and starts
async function generateNotesForFile(filePath, fileName) {
  console.log('Generate notes for:', filePath);

  // Set the current audio path
  currentAudioPath = filePath;

  // Switch to Process tab
  switchTab('process');

  // Update the UI to show which file we're processing
  document.getElementById('audio-file-select').innerHTML = `<option value="${filePath}">${fileName}</option>`;
  document.getElementById('audio-file-select').value = filePath;

  // Enable and auto-start transcription
  document.getElementById('transcribe-btn').disabled = false;

  // Auto-start transcription
  await transcribeAudio();
}
