import { computed, inject, Injectable, signal } from '@angular/core';
import { ElectronService } from './electron.service';
import { ComponentService } from './component.service';
import { ComponentStatus, InstallProgress } from '../models/types';

export type DownloadState = 'queued' | 'downloading' | 'done' | 'failed';

export interface DownloadItem {
  id: string;
  name: string;
  state: DownloadState;
  pct: number;
  received: number;
  total: number;
  message: string;
}

const CONCURRENCY = 2;

/**
 * Cross-cutting setup state: whether the wizard overlay is open, and the live
 * component-download queue (shared by the wizard's "finishing" screen and the
 * corner download dock). Ported from the original renderer's queue logic; the
 * `downloads` record drives both UIs reactively.
 */
@Injectable({ providedIn: 'root' })
export class SetupService {
  private readonly electron = inject(ElectronService);
  private readonly components = inject(ComponentService);

  // ─── Wizard overlay ──────────────────────────────────────────────────────────
  readonly wizardOpen = signal(false);
  readonly configMode = signal(false);

  openWizard(configMode: boolean): void {
    this.configMode.set(configMode);
    this.wizardOpen.set(true);
  }
  closeWizard(): void {
    this.wizardOpen.set(false);
  }

  // ─── Download queue ──────────────────────────────────────────────────────────
  readonly downloads = signal<Record<string, DownloadItem>>({});
  readonly dockDismissed = signal(false);
  readonly dockExpanded = signal(true);
  private active = 0;

  constructor() {
    // Single root subscription; progress events patch the matching item.
    this.electron.onComponentProgress((p) => this.onProgress(p));
  }

  readonly ids = computed(() => Object.keys(this.downloads()));

  /** Queue a component for install (no-op if installed or already in flight). */
  enqueue(status: ComponentStatus): void {
    const id = status.component.id;
    if (status.state === 'installed') return;
    const existing = this.downloads()[id];
    if (existing && existing.state !== 'failed') return;

    this.patch(id, {
      id,
      name: status.component.name,
      state: 'queued',
      pct: 0,
      received: 0,
      total: status.component.sizeBytes || 0,
      message: 'Queued',
    });
    this.dockDismissed.set(false);
    this.run();
  }

  private run(): void {
    while (this.active < CONCURRENCY) {
      const next = this.ids().find((id) => this.downloads()[id].state === 'queued');
      if (!next) break;
      this.start(next);
    }
  }

  private start(id: string): void {
    this.patch(id, { state: 'downloading', message: 'Starting…' });
    this.active++;
    this.electron
      .installComponent(id)
      .then((result) => {
        if (result.ok) this.patch(id, { state: 'done', pct: 100, message: 'Installed' });
        else this.patch(id, { state: 'failed', message: result.error || 'Failed' });
      })
      .catch((err: unknown) => {
        this.patch(id, { state: 'failed', message: err instanceof Error ? err.message : 'Failed' });
      })
      .finally(() => {
        this.active--;
        void this.components.refresh();
        this.run();
      });
  }

  private onProgress(p: InstallProgress): void {
    const item = this.downloads()[p.id];
    if (!item || item.state === 'done' || item.state === 'failed') return;
    switch (p.phase) {
      case 'download':
        this.patch(p.id, {
          pct: p.pct || 0,
          received: p.receivedBytes || 0,
          total: p.totalBytes || item.total,
          message: 'Downloading',
        });
        break;
      case 'verify':
        this.patch(p.id, { message: 'Verifying' });
        break;
      case 'extract':
        this.patch(p.id, { message: 'Extracting', pct: Math.max(item.pct, 99) });
        break;
      case 'done':
        this.patch(p.id, { pct: 100, message: 'Installed' });
        break;
      case 'error':
        this.patch(p.id, { state: 'failed', message: p.message || 'Failed' });
        break;
    }
  }

  private patch(id: string, patch: Partial<DownloadItem>): void {
    const current = this.downloads();
    const existing = current[id] ?? ({ id } as DownloadItem);
    this.downloads.set({ ...current, [id]: { ...existing, ...patch } });
  }

  /** True when every required component is installed or finished downloading. */
  requiredInstalled(): boolean {
    const required = this.components.statuses().filter((s) => s.component.required);
    if (required.length === 0) return true;
    const dl = this.downloads();
    return required.every(
      (s) => s.state === 'installed' || dl[s.component.id]?.state === 'done',
    );
  }
}
