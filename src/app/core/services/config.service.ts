import { inject, Injectable, signal } from '@angular/core';
import { ElectronService } from './electron.service';
import { AppConfig, DEFAULT_CONFIG } from '../models/types';

/** In-memory app config backed by the main-process config.json. */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly electron = inject(ElectronService);
  readonly config = signal<AppConfig>({ ...DEFAULT_CONFIG });

  /** Load saved config from disk, merged over the defaults. */
  async load(): Promise<void> {
    const saved = await this.electron.getConfig();
    this.config.set({ ...DEFAULT_CONFIG, ...this.config(), ...saved });
  }

  /** Update in memory only (no disk write). */
  patch(patch: Partial<AppConfig>): void {
    this.config.set({ ...this.config(), ...patch });
  }

  /** Patch and persist the full config to disk. */
  async save(patch: Partial<AppConfig> = {}): Promise<void> {
    const next = { ...this.config(), ...patch };
    this.config.set(next);
    await this.electron.saveConfig(next);
  }
}
