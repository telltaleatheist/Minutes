const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File Organization
  getDefaultDirectories: () => ipcRenderer.invoke('get-default-directories'),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('select-directory', defaultPath),
  selectAudioFile: (defaultPath) => ipcRenderer.invoke('select-audio-file', defaultPath),
  scanAudioSources: (rodecasterDir, outputDir) => ipcRenderer.invoke('scan-audio-sources', rodecasterDir, outputDir),
  finalizeFileSet: (fileSet, outputDir) => ipcRenderer.invoke('finalize-file-set', fileSet, outputDir),
  finalizeFileSets: (fileSets, outputDir) => ipcRenderer.invoke('finalize-file-sets', fileSets, outputDir),
  processDroppedFiles: (paths, setName) => ipcRenderer.invoke('process-dropped-files', paths, setName),

  // API Keys
  getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
  saveApiKey: (provider, apiKey) => ipcRenderer.invoke('save-api-key', provider, apiKey),

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Ollama
  checkOllama: (host) => ipcRenderer.invoke('check-ollama', host),

  // Transcription
  transcribeAudio: (audioPath, model) => ipcRenderer.invoke('transcribe-audio', audioPath, model),

  // AI Meeting Notes
  generateMeetingNotes: (transcript, config) => ipcRenderer.invoke('generate-meeting-notes', transcript, config),

  // Misc
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  saveNotes: (notes, outputPath) => ipcRenderer.invoke('save-notes', notes, outputPath),

  // Progress Events
  onProgress: (callback) => {
    ipcRenderer.on('finalize-progress', (event, data) => callback(data));
  },
  removeProgressListener: () => {
    ipcRenderer.removeAllListeners('finalize-progress');
  },
  onTranscriptionProgress: (callback) => {
    ipcRenderer.on('transcription-progress', (event, data) => callback(data));
  },
  removeTranscriptionProgressListener: () => {
    ipcRenderer.removeAllListeners('transcription-progress');
  }
});
