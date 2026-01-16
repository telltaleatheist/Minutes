// ============================================================================
// BOARDNOTES - RENDERER
// ============================================================================

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
  whisperModel: 'base'
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Load theme
  const savedTheme = localStorage.getItem('boardnotes-theme') || 'dark';
  document.body.setAttribute('data-theme', savedTheme);

  // Load directories
  const dirs = await window.electronAPI.getDefaultDirectories();
  if (dirs.rodecaster) {
    rodecasterDirectory = dirs.rodecaster;
    document.getElementById('rodecaster-dir').value = rodecasterDirectory;
  }
  if (dirs.output) {
    outputDirectory = dirs.output;
    document.getElementById('output-dir').value = outputDirectory;
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

  // Directory browsing
  document.getElementById('browse-rodecaster').addEventListener('click', browseRodecaster);
  document.getElementById('browse-output').addEventListener('click', browseOutput);
  document.getElementById('browse-audio').addEventListener('click', browseAudioFile);

  // Scanning
  document.getElementById('scan-btn').addEventListener('click', scanSources);
  document.getElementById('load-audio-btn').addEventListener('click', loadAudioDirectly);

  // Processing
  document.getElementById('transcribe-btn').addEventListener('click', transcribeAudio);
  document.getElementById('generate-btn').addEventListener('click', generateNotes);
  document.getElementById('save-btn').addEventListener('click', saveNotes);

  // Audio file selection
  document.getElementById('audio-file-select').addEventListener('change', onAudioFileSelect);

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
    updateProgress(data.percent, 100, data.message, 'Transcribing');
  });
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
// DIRECTORY BROWSING
// ============================================================================

async function browseRodecaster() {
  const dir = await window.electronAPI.selectDirectory(rodecasterDirectory);
  if (dir) {
    rodecasterDirectory = dir;
    document.getElementById('rodecaster-dir').value = dir;
  }
}

async function browseOutput() {
  const dir = await window.electronAPI.selectDirectory(outputDirectory);
  if (dir) {
    outputDirectory = dir;
    document.getElementById('output-dir').value = dir;
  }
}

async function browseAudioFile() {
  const filePath = await window.electronAPI.selectAudioFile();
  if (filePath) {
    currentAudioPath = filePath;
    const fileName = filePath.split('\\').pop();
    document.getElementById('audio-file-select').innerHTML = `<option value="${filePath}">${fileName}</option>`;
    document.getElementById('audio-file-select').value = filePath;
    document.getElementById('transcribe-btn').disabled = false;
    showToast('success', 'File Selected', fileName);
  }
}

async function loadAudioDirectly() {
  const filePath = await window.electronAPI.selectAudioFile();
  if (filePath) {
    currentAudioPath = filePath;
    const fileName = filePath.split('\\').pop();

    // Switch to Process tab
    switchTab('process');

    // Update the UI
    document.getElementById('audio-file-select').innerHTML = `<option value="${filePath}">${fileName}</option>`;
    document.getElementById('audio-file-select').value = filePath;
    document.getElementById('transcribe-btn').disabled = false;

    showToast('success', 'File Loaded', `Ready to transcribe: ${fileName}`);
  }
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
  updateProgress(0, 100, 'Loading Whisper model...', 'Whisper');

  // Start animated progress for transcription with varied messages
  let fakeProgress = 0;
  const progressMessages = [
    'Loading Whisper model...',
    'Processing audio file...',
    'Analyzing speech patterns...',
    'Converting speech to text...',
    'Recognizing words...',
    'Finalizing transcript...'
  ];
  let messageIndex = 0;

  const progressInterval = setInterval(() => {
    if (fakeProgress < 90) {
      fakeProgress += Math.random() * 2;
      // Cycle through progress messages
      if (fakeProgress > (messageIndex + 1) * 15 && messageIndex < progressMessages.length - 1) {
        messageIndex++;
      }
      updateProgress(Math.min(fakeProgress, 90), 100, progressMessages[messageIndex], 'Whisper');
    }
  }, 500);

  try {
    const result = await window.electronAPI.transcribeAudio(currentAudioPath, config.whisperModel);
    clearInterval(progressInterval);
    updateProgress(100, 100, 'Transcription complete!', 'Whisper');

    transcript = result.transcript;

    document.getElementById('transcript-output').textContent = transcript;
    document.getElementById('copy-transcript').disabled = false;

    setStepCompleted(1);
    document.getElementById('generate-btn').disabled = false;

    showToast('success', 'Transcription Complete', 'Audio has been transcribed successfully');
  } catch (error) {
    clearInterval(progressInterval);
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

function updateProviderUI() {
  const provider = document.getElementById('ai-provider').value;
  const ollamaHostGroup = document.getElementById('ollama-host-group');
  const modelSelect = document.getElementById('ai-model');

  // Show/hide Ollama host
  ollamaHostGroup.classList.toggle('hidden', provider !== 'ollama');

  // Update model options
  const models = {
    ollama: [
      { value: 'cogito:32b', label: 'Cogito 32B (Recommended)' },
      { value: 'cogito:14b', label: 'Cogito 14B' },
      { value: 'cogito:8b', label: 'Cogito 8B' },
      { value: 'qwen2.5:32b', label: 'Qwen 2.5 32B' },
      { value: 'llama3.2:latest', label: 'Llama 3.2' }
    ],
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

  modelSelect.innerHTML = models[provider].map(m =>
    `<option value="${m.value}">${m.label}</option>`
  ).join('');

  config.aiProvider = provider;
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
