import { computed, inject, Injectable, signal } from '@angular/core';
import { ComponentService } from './component.service';
import { ConfigService } from './config.service';
import { ElectronService } from './electron.service';
import { AiProvider, AppConfig } from '../models/types';

// Fallback minutes-per-hour-of-audio when we have no measured run yet. Rough,
// hardware-dependent; replaced by a real measurement once a model has been run.
const STATIC_MIN_PER_HOUR: Record<'gpu' | 'cpu', Record<string, number>> = {
  gpu: { tiny: 1.5, base: 2.5, small: 4, medium: 6.5, 'large-v3': 9 },
  cpu: { tiny: 5, base: 12, small: 30, medium: 80, 'large-v3': 160 },
};

/** One selectable AI model, flattened across providers. `value` is the unified
 *  key stored/compared as `<provider>:<model>` (model may itself contain ':',
 *  e.g. Ollama's "llama3:8b", so always split on the FIRST colon). */
export interface AiChoice {
  value: string;
  label: string;
  provider: AiProvider;
  model: string;
}

export interface WhisperChoice {
  value: string;
  label: string;
}

const CLOUD_MODELS: Record<'claude' | 'openai', { value: string; label: string }[]> = {
  claude: [
    { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'claude-3-haiku', label: 'Claude 3 Haiku' },
    { value: 'claude-3-opus', label: 'Claude 3 Opus' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
};

/**
 * Single source of truth for the model pickers shared by Settings and the main
 * Studio screen: the installed Whisper models and the unified AI-model list
 * (local + Ollama + cloud) plus the helpers to read/write the chosen AI model
 * as one config value instead of per-provider fields.
 */
@Injectable({ providedIn: 'root' })
export class ModelsService {
  private readonly components = inject(ComponentService);
  private readonly config = inject(ConfigService);
  private readonly electron = inject(ElectronService);

  readonly ollamaModels = signal<{ id: string; name: string }[]>([]);

  /** Installed transcription models, value = short name ('base', 'small', …).
   *  Label carries an approximate speed (minutes per hour of audio) for the
   *  current device, measured if we've run it before, else a static estimate. */
  readonly whisperChoices = computed<WhisperChoice[]>(() => {
    const cfg = this.config.config();
    const device: 'gpu' | 'cpu' = cfg.useGpu ? 'gpu' : 'cpu';
    return this.components
      .byCategory('whisper')
      .filter((s) => s.state === 'installed')
      .map((s) => {
        const short = s.component.id.replace('whisper-', '');
        const est = this.minutesPerHour(short, device, cfg.transcriptionRtf);
        const label = est ? `${s.component.name} — ~${est} min/hr` : s.component.name;
        return { value: short, label };
      });
  });

  /** Estimated minutes to transcribe one hour of audio, formatted compactly. */
  private minutesPerHour(short: string, device: 'gpu' | 'cpu', rtf?: Record<string, number>): string | null {
    const measured = rtf?.[`${short}|${device}`];
    const mph = measured != null ? measured * 60 : STATIC_MIN_PER_HOUR[device][short];
    if (!mph) return null;
    return mph >= 10 ? String(Math.round(mph)) : String(Math.round(mph * 10) / 10);
  }

  /** Every AI model the user can pick right now, across providers. Local/Ollama
   *  labels carry a plain-language speed hint based on the model size vs. this
   *  machine's VRAM/RAM, so a non-technical user can tell what their box can run. */
  readonly aiChoices = computed<AiChoice[]>(() => {
    const out: AiChoice[] = [];
    for (const s of this.components.byCategory('ai')) {
      if (s.state === 'installed') {
        const gb = s.component.sizeBytes ? s.component.sizeBytes / 1e9 : this.weightsGB(s.component.name);
        out.push({ value: `local:${s.component.id}`, label: this.withHint(`${s.component.name} (Local)`, gb), provider: 'local', model: s.component.id });
      }
    }
    for (const m of this.ollamaModels()) {
      out.push({ value: `ollama:${m.id}`, label: this.withHint(`${m.name} (Ollama)`, this.weightsGB(m.name || m.id)), provider: 'ollama', model: m.id });
    }
    for (const m of CLOUD_MODELS.claude) {
      out.push({ value: `claude:${m.value}`, label: `${m.label} (Claude)`, provider: 'claude', model: m.value });
    }
    for (const m of CLOUD_MODELS.openai) {
      out.push({ value: `openai:${m.value}`, label: `${m.label} (OpenAI)`, provider: 'openai', model: m.value });
    }
    return out;
  });

  /** Estimated Q4 weight footprint (GB) from a model name's parameter count. */
  private weightsGB(name: string): number | null {
    const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(name || '');
    return m ? parseFloat(m[1]) * 0.6 : null;
  }

  /** Append a plain-language speed hint to a label, judged against detected VRAM/RAM. */
  private withHint(label: string, weightsGB: number | null): string {
    if (weightsGB == null) return label;
    const sys = this.components.system();
    if (!sys) return label;
    const vramGB = (sys.cuda?.vramMB || 0) / 1024;
    const ramGB = (sys.ramMB || 0) / 1024;
    let hint: string;
    // "Fast" needs real headroom for the KV cache + compute alongside the weights
    // on the GPU — not just barely fitting the weights. ~6 GB covers our context.
    if (weightsGB + 6 <= vramGB) hint = 'Fast';
    else if (weightsGB + 2 <= vramGB + ramGB) hint = 'Slower — uses memory';
    else hint = 'Very slow — may not fit';
    return `${label} · ${hint}`;
  }

  /** The unified value for the model the config currently points at. */
  currentAiValue(cfg: AppConfig): string {
    return cfg.aiProvider === 'local' ? `local:${cfg.localAiModel}` : `${cfg.aiProvider}:${cfg.aiModel}`;
  }

  /** Translate a unified value back into the per-provider config fields. */
  patchForAi(value: string): Partial<AppConfig> {
    const i = value.indexOf(':');
    if (i < 0) return {};
    const provider = value.slice(0, i) as AiProvider;
    const model = value.slice(i + 1);
    return provider === 'local'
      ? { aiProvider: 'local', localAiModel: model }
      : { aiProvider: provider, aiModel: model };
  }

  async refreshOllama(host: string): Promise<void> {
    try {
      const r = await this.electron.checkOllama(host);
      this.ollamaModels.set(r.connected ? r.models : []);
    } catch {
      this.ollamaModels.set([]);
    }
  }
}
