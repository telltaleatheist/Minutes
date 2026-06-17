/**
 * Ambient types for the renderer's access to the preload bridge
 * (window.electronAPI). Kept loose for now; tightened as the IPC surface grows
 * (e.g. the component-download wizard). Mirrors preload.ts.
 */

interface ElectronAPI {
  // File organization
  getDefaultDirectories(): Promise<{ rodecaster: string | null; output: string }>;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectAudioFile(defaultPath?: string): Promise<string | null>;
  scanAudioSources(rodecasterDir: string, outputDir: string): Promise<any>;
  finalizeFileSet(fileSet: any, outputDir: string): Promise<any>;
  finalizeFileSets(fileSets: any, outputDir: string): Promise<any>;
  processDroppedFiles(paths: string[], setName: string): Promise<any>;

  // API keys
  getApiKeys(): Promise<{ claudeApiKey?: string; openaiApiKey?: string }>;
  saveApiKey(provider: string, apiKey: string): Promise<{ success: boolean; error?: string }>;

  // Config
  getConfig(): Promise<any>;
  saveConfig(config: any): Promise<{ success: boolean; error?: string }>;

  // Ollama
  checkOllama(host: string): Promise<{ connected: boolean; models: { id: string; name: string }[] }>;

  // Transcription
  transcribeAudio(audioPath: string, model: string): Promise<{ success: boolean; transcript: string }>;

  // AI meeting notes
  generateMeetingNotes(transcript: string, config: any): Promise<any>;

  // Misc
  openFolder(path: string): Promise<{ success: boolean; error?: string }>;
  saveNotes(notes: string, outputPath: string): Promise<{ success: boolean; error?: string }>;

  // Components (setup / downloads)
  detectSystem(): Promise<any>;
  listComponents(): Promise<any[]>;
  installComponent(id: string): Promise<{ id: string; ok: boolean; error?: string }>;
  cancelInstall(id: string): Promise<{ success: boolean }>;
  uninstallComponent(id: string): Promise<{ success: boolean; error?: string }>;
  onComponentProgress(callback: (data: any) => void): void;
  removeComponentProgressListener(): void;

  // Progress events
  onProgress(callback: (data: any) => void): void;
  removeProgressListener(): void;
  onTranscriptionProgress(callback: (data: any) => void): void;
  removeTranscriptionProgressListener(): void;
}

interface Window {
  electronAPI: ElectronAPI;
}
