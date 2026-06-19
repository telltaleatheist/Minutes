// The typed shape of the preload bridge (window.electronAPI), implemented in
// electron/preload.ts. Augments the global Window so the ElectronService can
// access it with full typing.
import type {
  ApiKeysStatus,
  AppConfig,
  ComponentStatus,
  GenerateConfig,
  GenerateResult,
  InstallProgress,
  InstallResult,
  OllamaResult,
  SaveResult,
  SystemProfile,
  TranscribeResult,
  TranscriptionProgress,
  GenerationProgress,
} from './types';

export interface ElectronAPI {
  // File organization (backend capability retained; not all surfaced in UI)
  getDefaultDirectories(): Promise<{ rodecaster: string | null; output: string }>;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectAudioFile(defaultPath?: string): Promise<string | null>;
  scanAudioSources(rodecasterDir: string, outputDir: string): Promise<unknown>;
  finalizeFileSet(fileSet: unknown, outputDir: string): Promise<unknown>;
  finalizeFileSets(fileSets: unknown, outputDir: string): Promise<unknown>;
  processDroppedFiles(paths: string[], setName: string): Promise<unknown>;

  // API keys
  getApiKeys(): Promise<ApiKeysStatus>;
  saveApiKey(provider: string, apiKey: string): Promise<SaveResult>;

  // Config
  getConfig(): Promise<Partial<AppConfig>>;
  saveConfig(config: AppConfig): Promise<SaveResult>;

  // Ollama
  checkOllama(host: string): Promise<OllamaResult>;

  // Transcription
  transcribeAudio(audioPath: string, model: string, useGpu?: boolean): Promise<TranscribeResult>;

  // AI meeting notes
  generateMeetingNotes(transcript: string, config: GenerateConfig): Promise<GenerateResult>;

  // Misc
  openFolder(path: string): Promise<SaveResult>;
  openLogsFolder(): Promise<SaveResult>;
  saveNotes(notes: string, outputPath: string): Promise<SaveResult>;

  // Components (setup / downloads)
  detectSystem(): Promise<SystemProfile>;
  listComponents(): Promise<ComponentStatus[]>;
  installComponent(id: string): Promise<InstallResult>;
  cancelInstall(id: string): Promise<{ success: boolean }>;
  uninstallComponent(id: string): Promise<SaveResult>;
  onComponentProgress(callback: (data: InstallProgress) => void): void;
  removeComponentProgressListener(): void;

  // Progress events
  onProgress(callback: (data: unknown) => void): void;
  removeProgressListener(): void;
  onTranscriptionProgress(callback: (data: TranscriptionProgress) => void): void;
  removeTranscriptionProgressListener(): void;
  onGenerationProgress(callback: (data: GenerationProgress) => void): void;
  removeGenerationProgressListener(): void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
