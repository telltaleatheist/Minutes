import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { SetupService } from '../../core/services/setup.service';
import { ComponentService } from '../../core/services/component.service';
import { ConfigService } from '../../core/services/config.service';
import { ElectronService } from '../../core/services/electron.service';
import { ToastService } from '../../core/services/toast.service';
import { AiProvider, AppConfig, DEFAULT_NOTES_PROMPT } from '../../core/models/types';

const CLOUD_MODELS: Record<'claude' | 'openai', { value: string; label: string }[]> = {
  claude: [
    { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (Recommended)' },
    { value: 'claude-3-haiku', label: 'Claude 3 Haiku (Fast)' },
    { value: 'claude-3-opus', label: 'Claude 3 Opus (Best)' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (Recommended)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
};

/**
 * Settings overlay — a single page for picking the defaults the app runs with:
 * which AI provider/model, which transcription model, CPU vs GPU, API keys, and
 * the meeting-notes prompt. Distinct from the download wizard (which is for
 * browsing & downloading component options); a "Manage downloads" button links
 * across to it.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (setup.settingsOpen()) {
      <div class="setup-overlay">
        <div class="setup-card">
          <div class="setup-card-head">
            <h2>Settings</h2>
            <button class="btn btn-ghost btn-icon" title="Close" (click)="close()">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path
                  d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                />
              </svg>
            </button>
          </div>

          <div class="setup-card-body">
            <!-- Defaults: what the app uses out of the box -->
            <div class="settings-section">
              <div class="settings-section-title">Defaults</div>
              <div class="settings-grid">
                <div class="form-group">
                  <label class="form-label">Transcription model (Whisper)</label>
                  <select class="form-control" [value]="whisperModel()" (change)="whisperModel.set($any($event.target).value)">
                    @for (o of whisperOptions(); track o.value) {
                      <option [value]="o.value">{{ o.label }}</option>
                    } @empty {
                      <option value="">No models installed — see Downloads</option>
                    }
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Default AI model (local)</label>
                  <select class="form-control" [value]="localAiModel()" (change)="localAiModel.set($any($event.target).value)">
                    @for (o of localAiOptions(); track o.value) {
                      <option [value]="o.value">{{ o.label }}</option>
                    } @empty {
                      <option value="">No models installed — see Downloads</option>
                    }
                  </select>
                </div>
              </div>
            </div>

            <!-- Compute device -->
            <div class="settings-section">
              <div class="settings-section-title">Processing device</div>
              <p class="sub">Used for both transcription and local AI analysis.</p>
              <div class="device-toggle">
                <button
                  class="btn"
                  [class.btn-primary]="!useGpu()"
                  [class.btn-secondary]="useGpu()"
                  (click)="useGpu.set(false)"
                >
                  CPU
                </button>
                <button
                  class="btn"
                  [class.btn-primary]="useGpu()"
                  [class.btn-secondary]="!useGpu()"
                  (click)="useGpu.set(true)"
                >
                  GPU
                </button>
              </div>
              <p class="form-label mt-1" [style.color]="gpuAvailable() ? 'var(--success)' : 'var(--text-tertiary)'">
                {{ gpuHint() }}
              </p>
            </div>

            <!-- AI provider -->
            <div class="settings-section">
              <div class="settings-section-title">AI provider</div>
              <div class="settings-grid">
                <div class="form-group">
                  <label class="form-label">Provider</label>
                  <select class="form-control" [value]="provider()" (change)="onProviderChange($event)">
                    <option value="local">Local (downloaded model)</option>
                    <option value="ollama">Ollama</option>
                    <option value="claude">Claude (Anthropic)</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </div>
                @if (provider() === 'ollama') {
                  <div class="form-group">
                    <label class="form-label">Ollama host</label>
                    <div class="input-group">
                      <input
                        type="text"
                        class="form-control"
                        [value]="ollamaHost()"
                        (input)="ollamaHost.set($any($event.target).value)"
                      />
                      <button class="btn btn-secondary btn-sm" (click)="checkOllama()">Check</button>
                    </div>
                  </div>
                }
                @if (provider() !== 'local') {
                  <div class="form-group">
                    <label class="form-label">Cloud model</label>
                    <select class="form-control" [value]="aiModel()" (change)="aiModel.set($any($event.target).value)">
                      @for (m of aiModelOptions(); track m.value) {
                        <option [value]="m.value">{{ m.label }}</option>
                      } @empty {
                        <option value="">No models available</option>
                      }
                    </select>
                  </div>
                }
              </div>
            </div>

            <!-- API keys -->
            <div class="settings-section">
              <div class="settings-section-title">API keys</div>
              <div class="settings-grid">
                <div class="form-group">
                  <label class="form-label">Claude API key</label>
                  <div class="input-group">
                    <input #claudeKey type="password" class="form-control" placeholder="sk-ant-..." />
                    <button class="btn btn-secondary btn-sm" (click)="saveApiKey('claude', claudeKey.value); claudeKey.value = ''">
                      Save
                    </button>
                  </div>
                  <span class="form-label mt-1" [style.color]="claudeConfigured() ? 'var(--success)' : 'var(--text-tertiary)'">
                    {{ claudeConfigured() ? 'Configured' : 'Not configured' }}
                  </span>
                </div>
                <div class="form-group">
                  <label class="form-label">OpenAI API key</label>
                  <div class="input-group">
                    <input #openaiKey type="password" class="form-control" placeholder="sk-..." />
                    <button class="btn btn-secondary btn-sm" (click)="saveApiKey('openai', openaiKey.value); openaiKey.value = ''">
                      Save
                    </button>
                  </div>
                  <span class="form-label mt-1" [style.color]="openaiConfigured() ? 'var(--success)' : 'var(--text-tertiary)'">
                    {{ openaiConfigured() ? 'Configured' : 'Not configured' }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Notes prompt -->
            <div class="settings-section">
              <div class="settings-section-title">
                Meeting-notes prompt
                <button class="btn btn-ghost btn-sm" (click)="resetPrompt()">Reset to default</button>
              </div>
              <p class="sub">The instructions sent to the AI when generating notes. Edit to change the style, sections, or tone.</p>
              <textarea
                class="form-control prompt-area"
                rows="12"
                [value]="notesPrompt()"
                (input)="notesPrompt.set($any($event.target).value)"
              ></textarea>
            </div>
          </div>

          <div class="setup-card-foot">
            <button class="btn btn-secondary" (click)="openDownloads()">Manage downloads</button>
            <span class="spacer"></span>
            <button class="btn btn-ghost" (click)="close()">Cancel</button>
            <button class="btn btn-primary" (click)="save()">Save settings</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SettingsComponent {
  readonly setup = inject(SetupService);
  private readonly components = inject(ComponentService);
  private readonly config = inject(ConfigService);
  private readonly electron = inject(ElectronService);
  private readonly toast = inject(ToastService);

  readonly provider = signal<AiProvider>('local');
  readonly ollamaHost = signal('http://127.0.0.1:11434');
  readonly aiModel = signal('');
  readonly whisperModel = signal('');
  readonly localAiModel = signal('');
  readonly useGpu = signal(false);
  readonly notesPrompt = signal('');

  private readonly ollamaModels = signal<{ id: string; name: string }[]>([]);
  readonly claudeConfigured = signal(false);
  readonly openaiConfigured = signal(false);

  constructor() {
    // Re-sync the form from saved config each time the overlay opens.
    let wasOpen = false;
    effect(() => {
      const open = this.setup.settingsOpen();
      if (open && !wasOpen) this.onOpen();
      wasOpen = open;
    });
  }

  private onOpen(): void {
    const cfg = this.config.config();
    this.provider.set(cfg.aiProvider);
    this.ollamaHost.set(cfg.ollamaHost);
    this.aiModel.set(cfg.aiModel);
    this.whisperModel.set(cfg.whisperModel);
    this.localAiModel.set(cfg.localAiModel);
    this.useGpu.set(cfg.useGpu);
    this.notesPrompt.set(cfg.notesPrompt || DEFAULT_NOTES_PROMPT);
    if (cfg.aiProvider === 'ollama') void this.refreshOllamaModels();
    void this.loadApiKeys();
  }

  // ─── Installed-model options ─────────────────────────────────────────────────
  readonly whisperOptions = computed(() =>
    this.components
      .byCategory('whisper')
      .filter((s) => s.state === 'installed')
      .map((s) => ({ value: s.component.id.replace('whisper-', ''), label: s.component.name })),
  );

  readonly localAiOptions = computed(() =>
    this.components
      .byCategory('ai')
      .filter((s) => s.state === 'installed')
      .map((s) => ({ value: s.component.id, label: s.component.name })),
  );

  // ─── GPU hint ────────────────────────────────────────────────────────────────
  readonly gpuAvailable = computed(() => {
    const sys = this.components.system();
    return !!sys && (sys.cuda?.available || sys.appleSilicon);
  });

  readonly gpuHint = computed(() => {
    const sys = this.components.system();
    if (!sys) return 'GPU availability unknown.';
    if (sys.cuda?.available) return `NVIDIA ${sys.cuda.name || 'GPU'} detected.`;
    if (sys.appleSilicon) return 'Apple Silicon GPU (Metal) detected.';
    return 'No GPU detected — GPU mode falls back to CPU.';
  });

  // ─── Cloud provider ──────────────────────────────────────────────────────────
  readonly aiModelOptions = computed(() => {
    const p = this.provider();
    if (p === 'ollama') return this.ollamaModels().map((m) => ({ value: m.id, label: m.name }));
    if (p === 'claude' || p === 'openai') return CLOUD_MODELS[p];
    return [];
  });

  onProviderChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as AiProvider;
    this.provider.set(value);
    if (value === 'ollama') void this.refreshOllamaModels();
  }

  private async refreshOllamaModels(): Promise<void> {
    try {
      const result = await this.electron.checkOllama(this.ollamaHost());
      this.ollamaModels.set(result.connected ? result.models : []);
    } catch {
      this.ollamaModels.set([]);
    }
  }

  async checkOllama(): Promise<void> {
    try {
      const result = await this.electron.checkOllama(this.ollamaHost());
      if (result.connected) {
        this.ollamaModels.set(result.models);
        this.toast.show('success', 'Connected', `Found ${result.models.length} model(s)`);
      } else {
        this.toast.show('error', 'Not Connected', 'Could not connect to Ollama');
      }
    } catch (err) {
      this.toast.show('error', 'Error', err instanceof Error ? err.message : String(err));
    }
  }

  // ─── API keys ────────────────────────────────────────────────────────────────
  private async loadApiKeys(): Promise<void> {
    const keys = await this.electron.getApiKeys();
    this.claudeConfigured.set(!!keys.claudeApiKey);
    this.openaiConfigured.set(!!keys.openaiApiKey);
  }

  async saveApiKey(provider: 'claude' | 'openai', apiKey: string): Promise<void> {
    if (!apiKey.trim()) {
      this.toast.show('error', 'Error', 'Please enter an API key');
      return;
    }
    const result = await this.electron.saveApiKey(provider, apiKey.trim());
    if (result.success) {
      if (provider === 'claude') this.claudeConfigured.set(true);
      else this.openaiConfigured.set(true);
      const name = provider.charAt(0).toUpperCase() + provider.slice(1);
      this.toast.show('success', 'Saved', `${name} API key saved`);
    } else {
      this.toast.show('error', 'Error', result.error || 'Failed to save key');
    }
  }

  // ─── Prompt ──────────────────────────────────────────────────────────────────
  resetPrompt(): void {
    this.notesPrompt.set(DEFAULT_NOTES_PROMPT);
  }

  // ─── Save / nav ──────────────────────────────────────────────────────────────
  async save(): Promise<void> {
    // Persist the prompt only when it differs from the built-in default, so a
    // future change to the default still reaches users who never edited it.
    const prompt = this.notesPrompt().trim();
    const patch: Partial<AppConfig> = {
      aiProvider: this.provider(),
      ollamaHost: this.ollamaHost(),
      aiModel: this.aiModel(),
      whisperModel: this.whisperModel(),
      localAiModel: this.localAiModel(),
      useGpu: this.useGpu(),
      notesPrompt: prompt === DEFAULT_NOTES_PROMPT.trim() ? '' : prompt,
    };
    await this.config.save(patch);
    this.toast.show('success', 'Saved', 'Settings saved');
    this.setup.closeSettings();
  }

  openDownloads(): void {
    this.setup.closeSettings();
    this.setup.openWizard(true);
  }

  close(): void {
    this.setup.closeSettings();
  }
}
