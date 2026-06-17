import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { SelectCardComponent } from './select-card.component';
import { SetupService } from '../../core/services/setup.service';
import { ComponentService } from '../../core/services/component.service';
import { ConfigService } from '../../core/services/config.service';
import { ElectronService } from '../../core/services/electron.service';
import { ToastService } from '../../core/services/toast.service';
import { AiProvider, AppConfig, ComponentStatus } from '../../core/models/types';
import { formatSize } from '../../core/utils/format';

const WIZARD_STEPS = ['welcome', 'ai', 'whisper', 'tools', 'review', 'finishing'] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];
const NUMBERED_STEPS = 5; // welcome..review (finishing is terminal)

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
 * First-run + reconfiguration wizard (overlay). Walks the user through picking
 * AI/Whisper models and optional tools, queues the downloads via SetupService,
 * and gates the home screen until the required components are installed.
 */
@Component({
  selector: 'app-setup-wizard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SelectCardComponent],
  template: `
    @if (setup.wizardOpen()) {
      <div class="setup-overlay">
        <div class="setup-card">
          <div class="setup-card-head">
            <h2>{{ setup.configMode() ? 'Minutes setup' : 'Set up Minutes' }}</h2>
            @if (setup.configMode()) {
              <button class="btn btn-ghost btn-icon" title="Close" (click)="close()">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path
                    d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                  />
                </svg>
              </button>
            }
          </div>

          <div class="steps-indicator">
            <span class="step-count">{{ stepCountLabel() }}</span>
            <div class="step-dots">
              @for (i of dotIndexes; track i) {
                <span class="step-dot" [class.done]="i < step()" [class.active]="i === step()"></span>
              }
            </div>
          </div>

          <div class="setup-card-body">
            @switch (stepName()) {
              @case ('welcome') {
                <div class="setup-step">
                  <div class="step-head">
                    <h3>Welcome to Minutes</h3>
                    <p class="sub">
                      Minutes runs entirely on your computer. We'll grab a couple of required tools
                      and let you pick which AI and transcription models to download. It only takes a
                      few clicks.
                    </p>
                  </div>
                  <div class="system-info">
                    @if (system(); as sys) {
                      <span class="sys-chip">{{ sys.platform }}/{{ sys.arch }}</span>
                      <span class="sys-chip">{{ ramGB() }} GB RAM</span>
                      <span class="sys-chip">{{ diskLabel() }}</span>
                      <span class="sys-chip" [class.sys-chip-gpu]="hasGpu()">{{ gpuLabel() }}</span>
                    } @else {
                      Detecting your system…
                    }
                  </div>
                </div>
              }

              @case ('ai') {
                <div class="setup-step">
                  <div class="step-head">
                    <h3>Choose an AI model</h3>
                    <p class="sub">
                      Runs locally to turn your transcript into meeting notes. Pick one (you can add
                      more later). The local AI engine downloads automatically.
                    </p>
                  </div>
                  <div class="select-list">
                    @for (s of aiList(); track s.component.id) {
                      <app-select-card
                        [status]="s"
                        [checked]="isChecked(s)"
                        (toggled)="toggle(s)"
                      />
                    } @empty {
                      <p class="text-tertiary">Nothing here.</p>
                    }
                  </div>

                  <details class="cloud-details">
                    <summary>Or connect a cloud provider instead</summary>
                    <div class="settings-grid mt-3">
                      <div class="settings-section">
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
                            <label class="form-label">Ollama Host</label>
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
                        <div class="form-group">
                          <label class="form-label">Cloud Model</label>
                          <select class="form-control" [value]="aiModel()" (change)="aiModel.set($any($event.target).value)">
                            @for (m of aiModelOptions(); track m.value) {
                              <option [value]="m.value">{{ m.label }}</option>
                            }
                          </select>
                        </div>
                      </div>
                      <div class="settings-section">
                        <div class="form-group">
                          <label class="form-label">Claude API Key</label>
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
                          <label class="form-label">OpenAI API Key</label>
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
                  </details>
                </div>
              }

              @case ('whisper') {
                <div class="setup-step">
                  <div class="step-head">
                    <h3>Choose a transcription model</h3>
                    <p class="sub">
                      Whisper converts your audio to text. Larger models are more accurate but
                      slower. Pick one or more.
                    </p>
                  </div>
                  <div class="select-list">
                    @for (s of whisperList(); track s.component.id) {
                      <app-select-card [status]="s" [checked]="isChecked(s)" (toggled)="toggle(s)" />
                    } @empty {
                      <p class="text-tertiary">Nothing here.</p>
                    }
                  </div>
                </div>
              }

              @case ('tools') {
                <div class="setup-step">
                  <div class="step-head">
                    <h3>Optional extras</h3>
                    <p class="sub">
                      FFmpeg and the local AI engine are required and download automatically. If we
                      detect an NVIDIA GPU, you can add CUDA acceleration here.
                    </p>
                  </div>
                  <div class="select-list">
                    @for (s of toolsList(); track s.component.id) {
                      @if (s.component.required) {
                        <div class="select-card disabled">
                          <div class="select-info">
                            <div class="select-name">{{ s.component.name }}</div>
                            <div class="select-desc">{{ s.component.description }}</div>
                          </div>
                          <div class="select-meta">
                            @if (s.state === 'installed') {
                              <span class="badge badge-ok">Installed</span>
                            } @else {
                              <span class="badge badge-rec">Required · automatic</span>
                            }
                          </div>
                        </div>
                      } @else {
                        <app-select-card [status]="s" [checked]="isChecked(s)" (toggled)="toggle(s)" />
                      }
                    } @empty {
                      <p class="text-tertiary">No optional tools for this system.</p>
                    }
                  </div>
                </div>
              }

              @case ('review') {
                <div class="setup-step">
                  <div class="step-head">
                    <h3>Review &amp; download</h3>
                    <p class="sub">
                      Everything you picked, plus the required tools. Downloads run in the corner —
                      you can leave this open or come back later.
                    </p>
                  </div>
                  <div class="review-list">
                    @for (s of reviewItems(); track s.component.id) {
                      <div class="review-row">
                        <span>
                          {{ s.component.name }}
                          @if (s.component.required) {
                            <span class="badge badge-rec">Required</span>
                          }
                        </span>
                        <span class="select-size">{{ size(s.component.sizeBytes) }}</span>
                      </div>
                    } @empty {
                      <p class="text-tertiary">Everything needed is already installed.</p>
                    }
                    @if (reviewItems().length) {
                      <div class="review-total">
                        <span>Total download</span><span>{{ size(reviewTotal()) }}</span>
                      </div>
                    }
                  </div>
                  <div class="settings-grid mt-3">
                    <div class="form-group">
                      <label class="form-label">Default transcription model</label>
                      <select class="form-control" [value]="defaultWhisper()" (change)="defaultWhisper.set($any($event.target).value)">
                        @for (o of defaultWhisperOptions(); track o.value) {
                          <option [value]="o.value">{{ o.label }}</option>
                        } @empty {
                          <option value="">No models selected yet</option>
                        }
                      </select>
                    </div>
                    <div class="form-group">
                      <label class="form-label">Default AI model</label>
                      <select class="form-control" [value]="defaultAi()" (change)="defaultAi.set($any($event.target).value)">
                        @for (o of defaultAiOptions(); track o.value) {
                          <option [value]="o.value">{{ o.label }}</option>
                        } @empty {
                          <option value="">No models selected yet</option>
                        }
                      </select>
                    </div>
                  </div>
                </div>
              }

              @case ('finishing') {
                <div class="setup-step">
                  <div class="finishing">
                    <div class="engine-spinner"></div>
                    <h3>Setting things up…</h3>
                    <p class="finishing-sub">
                      Downloading the tools Minutes needs. This screen will open the app as soon as
                      the essentials are ready.
                    </p>
                    <div class="finish-bar"><div class="finish-bar-fill" [style.width.%]="finishPct()"></div></div>
                    <p class="finish-stage">
                      {{ ready() ? 'Essentials ready.' : 'Preparing required tools… ' + finishPct() + '%' }}
                    </p>
                  </div>
                </div>
              }
            }
          </div>

          <div class="setup-card-foot">
            <button class="btn btn-secondary" [disabled]="step() === 0" (click)="back()">Back</button>
            <span class="spacer"></span>
            @if (setup.configMode()) {
              <button class="btn btn-ghost" (click)="saveSettings()">Save preferences</button>
            }
            @if (stepName() === 'finishing') {
              <button class="btn btn-primary" [disabled]="!ready()" (click)="finishWizardToHome()">Open Minutes</button>
            } @else {
              <button class="btn btn-primary" (click)="next()">
                {{ stepName() === 'review' ? 'Begin setup' : 'Next' }}
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class SetupWizardComponent {
  readonly setup = inject(SetupService);
  private readonly components = inject(ComponentService);
  private readonly config = inject(ConfigService);
  private readonly electron = inject(ElectronService);
  private readonly toast = inject(ToastService);

  readonly step = signal(0);
  readonly stepName = computed<WizardStep>(() => WIZARD_STEPS[this.step()]);
  readonly dotIndexes = Array.from({ length: NUMBERED_STEPS }, (_, i) => i);

  private readonly selected = signal<Set<string>>(new Set());

  // Cloud-provider settings (mirrors the original embedded settings panel)
  readonly provider = signal<AiProvider>('local');
  readonly ollamaHost = signal('http://127.0.0.1:11434');
  readonly aiModel = signal('');
  private readonly ollamaModels = signal<{ id: string; name: string }[]>([]);
  readonly claudeConfigured = signal(false);
  readonly openaiConfigured = signal(false);

  // Defaults chosen on the review step
  readonly defaultWhisper = signal('');
  readonly defaultAi = signal('');

  // ─── Derived component lists ─────────────────────────────────────────────────
  readonly aiList = computed(() => this.components.byCategory('ai'));
  readonly whisperList = computed(() => this.components.byCategory('whisper'));
  readonly toolsList = computed(() =>
    this.components.statuses().filter(
      (s) => s.component.category === 'tool' || s.component.category === 'accelerator',
    ),
  );
  readonly system = computed(() => this.components.system());

  constructor() {
    // Initialize the wizard each time it opens.
    let wasOpen = false;
    effect(() => {
      const open = this.setup.wizardOpen();
      if (open && !wasOpen) this.onOpen();
      wasOpen = open;
    });

    // Auto-advance home once the essentials are ready and we're on the gate.
    effect(() => {
      if (
        this.stepName() === 'finishing' &&
        this.setup.wizardOpen() &&
        this.ready() &&
        !this.config.config().setupComplete
      ) {
        void this.finishWizardToHome();
      }
    });
  }

  private onOpen(): void {
    this.step.set(0);
    const cfg = this.config.config();
    this.provider.set(cfg.aiProvider);
    this.ollamaHost.set(cfg.ollamaHost);
    this.aiModel.set(cfg.aiModel);
    this.defaultWhisper.set(cfg.whisperModel);
    this.defaultAi.set(cfg.localAiModel);

    // Pre-select recommended, compatible AI + Whisper models.
    const next = new Set<string>();
    for (const s of this.components.statuses()) {
      if (
        s.component.recommended &&
        s.state !== 'incompatible' &&
        (s.component.category === 'ai' || s.component.category === 'whisper')
      ) {
        next.add(s.component.id);
      }
    }
    this.selected.set(next);

    void this.loadApiKeys();
  }

  private async loadApiKeys(): Promise<void> {
    const keys = await this.electron.getApiKeys();
    this.claudeConfigured.set(!!keys.claudeApiKey);
    this.openaiConfigured.set(!!keys.openaiApiKey);
  }

  // ─── Selection ───────────────────────────────────────────────────────────────
  isChecked(s: ComponentStatus): boolean {
    return s.state === 'installed' || this.selected().has(s.component.id);
  }

  toggle(s: ComponentStatus): void {
    const next = new Set(this.selected());
    if (next.has(s.component.id)) next.delete(s.component.id);
    else next.add(s.component.id);
    this.selected.set(next);
  }

  // ─── Navigation ──────────────────────────────────────────────────────────────
  next(): void {
    switch (this.stepName()) {
      case 'welcome':
        this.enqueueRequired();
        break;
      case 'ai':
        this.enqueueSelectedCategory('ai');
        break;
      case 'whisper':
        this.enqueueSelectedCategory('whisper');
        break;
      case 'tools':
        this.enqueueSelectedCategory('accelerator');
        break;
      case 'review':
        this.beginSetup();
        return;
    }
    this.step.update((n) => n + 1);
  }

  back(): void {
    if (this.step() > 0) this.step.update((n) => n - 1);
  }

  private beginSetup(): void {
    this.enqueueRequired();
    for (const s of this.components.statuses()) {
      if (this.selected().has(s.component.id)) this.setup.enqueue(s);
    }
    this.applyDefaults();
    this.step.set(WIZARD_STEPS.indexOf('finishing'));
  }

  private enqueueRequired(): void {
    for (const s of this.components.statuses()) {
      if (s.component.required) this.setup.enqueue(s);
    }
  }

  private enqueueSelectedCategory(category: string): void {
    for (const s of this.components.statuses()) {
      if (s.component.category === category && this.selected().has(s.component.id)) {
        this.setup.enqueue(s);
      }
    }
  }

  // ─── Cloud provider settings ─────────────────────────────────────────────────
  readonly aiModelOptions = computed(() => {
    const p = this.provider();
    if (p === 'local') return [{ value: '', label: 'Uses the default AI model selected above' }];
    if (p === 'ollama') return this.ollamaModels().map((m) => ({ value: m.id, label: m.name }));
    return CLOUD_MODELS[p];
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

  // ─── Review + defaults ───────────────────────────────────────────────────────
  readonly reviewItems = computed<ComponentStatus[]>(() => {
    const list: ComponentStatus[] = [];
    const seen = new Set<string>();
    const add = (s: ComponentStatus) => {
      if (s.state !== 'installed' && !seen.has(s.component.id)) {
        seen.add(s.component.id);
        list.push(s);
      }
    };
    this.components.statuses().filter((s) => s.component.required).forEach(add);
    this.components.statuses().filter((s) => this.selected().has(s.component.id)).forEach(add);
    return list;
  });

  readonly reviewTotal = computed(() =>
    this.reviewItems().reduce((sum, s) => sum + (s.component.sizeBytes || 0), 0),
  );

  readonly defaultWhisperOptions = computed(() =>
    this.whisperList()
      .filter((s) => s.state === 'installed' || this.selected().has(s.component.id))
      .map((s) => ({ value: s.component.id.replace('whisper-', ''), label: s.component.name })),
  );

  readonly defaultAiOptions = computed(() =>
    this.aiList()
      .filter((s) => s.state === 'installed' || this.selected().has(s.component.id))
      .map((s) => ({ value: s.component.id, label: s.component.name })),
  );

  private applyDefaults(): void {
    const patch: Partial<AppConfig> = { aiProvider: this.provider() };
    if (this.defaultWhisper()) patch.whisperModel = this.defaultWhisper();
    if (this.defaultAi()) patch.localAiModel = this.defaultAi();
    this.config.patch(patch);
  }

  // ─── Finishing ───────────────────────────────────────────────────────────────
  readonly ready = computed(() => this.setup.requiredInstalled());

  readonly finishPct = computed(() => {
    const dl = this.setup.downloads();
    const req = this.components
      .statuses()
      .filter((s) => s.component.required)
      .map((s) => dl[s.component.id])
      .filter((d): d is NonNullable<typeof d> => !!d);
    if (req.length) {
      return Math.round(
        req.reduce((s, d) => s + (d.state === 'done' ? 100 : d.pct || 0), 0) / req.length,
      );
    }
    return this.ready() ? 100 : 0;
  });

  async finishWizardToHome(): Promise<void> {
    this.applyDefaults();
    await this.config.save({ setupComplete: true });
    this.setup.closeWizard();
    this.setup.dockExpanded.set(false);
    this.toast.show(
      'success',
      'Ready',
      'Minutes is set up. Any remaining downloads continue in the corner.',
    );
  }

  // ─── Config-mode actions ─────────────────────────────────────────────────────
  async saveSettings(): Promise<void> {
    const patch: Partial<AppConfig> = {
      aiProvider: this.provider(),
      ollamaHost: this.ollamaHost(),
    };
    if (this.aiModel()) patch.aiModel = this.aiModel();
    if (this.defaultWhisper()) patch.whisperModel = this.defaultWhisper();
    if (this.defaultAi()) patch.localAiModel = this.defaultAi();
    await this.config.save(patch);
    this.toast.show('success', 'Saved', 'Settings saved successfully');
  }

  close(): void {
    if (this.config.config().setupComplete && this.setup.requiredInstalled()) {
      this.setup.closeWizard();
    }
  }

  size(bytes: number): string {
    return formatSize(bytes);
  }

  // ─── Welcome system chips ────────────────────────────────────────────────────
  readonly ramGB = computed(() => ((this.system()?.ramMB ?? 0) / 1024).toFixed(1));
  readonly hasGpu = computed(() => !!this.system()?.cuda?.available);
  readonly diskLabel = computed(() => {
    const free = this.system()?.freeDiskMB;
    return free && free < Number.MAX_SAFE_INTEGER
      ? `${(free / 1024).toFixed(0)} GB free`
      : 'free space unknown';
  });
  readonly gpuLabel = computed(() => {
    const cuda = this.system()?.cuda;
    if (!cuda?.available) return 'No CUDA GPU';
    return `NVIDIA ${cuda.name || 'GPU'}${cuda.vramMB ? ` · ${(cuda.vramMB / 1024).toFixed(0)} GB` : ''}`;
  });

  readonly stepCountLabel = computed(() =>
    this.stepName() === 'finishing' ? 'Finishing up' : `Step ${this.step() + 1} of ${NUMBERED_STEPS}`,
  );
}
