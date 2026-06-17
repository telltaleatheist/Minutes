import { Injectable } from '@angular/core';
import type { ElectronAPI } from '../models/electron-api';
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
} from '../models/types';

/**
 * Thin, typed wrapper around the preload bridge (window.electronAPI). Every
 * renderer↔main interaction goes through this service so components never reach
 * into `window` directly. Event channels are exposed as subscribe methods that
 * return an unsubscribe function for easy cleanup in effects/DestroyRef.
 */
@Injectable({ providedIn: 'root' })
export class ElectronService {
  private readonly api: ElectronAPI = window.electronAPI;
  readonly isElectron = !!window.electronAPI;

  // ─── Config ────────────────────────────────────────────────────────────────
  getConfig(): Promise<Partial<AppConfig>> {
    return this.api.getConfig();
  }
  saveConfig(config: AppConfig): Promise<SaveResult> {
    return this.api.saveConfig(config);
  }

  // ─── API keys ────────────────────────────────────────────────────────────────
  getApiKeys(): Promise<ApiKeysStatus> {
    return this.api.getApiKeys();
  }
  saveApiKey(provider: string, apiKey: string): Promise<SaveResult> {
    return this.api.saveApiKey(provider, apiKey);
  }

  // ─── Directories ─────────────────────────────────────────────────────────────
  getDefaultDirectories(): Promise<{ rodecaster: string | null; output: string }> {
    return this.api.getDefaultDirectories();
  }
  selectAudioFile(defaultPath?: string): Promise<string | null> {
    return this.api.selectAudioFile(defaultPath);
  }

  // ─── Ollama ──────────────────────────────────────────────────────────────────
  checkOllama(host: string): Promise<OllamaResult> {
    return this.api.checkOllama(host);
  }

  // ─── Transcription ───────────────────────────────────────────────────────────
  transcribeAudio(audioPath: string, model: string): Promise<TranscribeResult> {
    return this.api.transcribeAudio(audioPath, model);
  }

  // ─── Notes ───────────────────────────────────────────────────────────────────
  generateMeetingNotes(transcript: string, config: GenerateConfig): Promise<GenerateResult> {
    return this.api.generateMeetingNotes(transcript, config);
  }
  saveNotes(notes: string, outputPath: string): Promise<SaveResult> {
    return this.api.saveNotes(notes, outputPath);
  }
  openFolder(path: string): Promise<SaveResult> {
    return this.api.openFolder(path);
  }

  // ─── Components / setup ──────────────────────────────────────────────────────
  detectSystem(): Promise<SystemProfile> {
    return this.api.detectSystem();
  }
  listComponents(): Promise<ComponentStatus[]> {
    return this.api.listComponents();
  }
  installComponent(id: string): Promise<InstallResult> {
    return this.api.installComponent(id);
  }

  // ─── Event channels (return an unsubscribe fn) ───────────────────────────────
  onTranscriptionProgress(cb: (data: TranscriptionProgress) => void): () => void {
    this.api.onTranscriptionProgress(cb);
    return () => this.api.removeTranscriptionProgressListener();
  }
  onComponentProgress(cb: (data: InstallProgress) => void): () => void {
    this.api.onComponentProgress(cb);
    return () => this.api.removeComponentProgressListener();
  }
}
