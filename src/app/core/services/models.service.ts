import { computed, inject, Injectable, signal } from '@angular/core';
import { ComponentService } from './component.service';
import { ElectronService } from './electron.service';
import { AiProvider, AppConfig } from '../models/types';

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
  private readonly electron = inject(ElectronService);

  readonly ollamaModels = signal<{ id: string; name: string }[]>([]);

  /** Installed transcription models, value = short name ('base', 'small', …). */
  readonly whisperChoices = computed<WhisperChoice[]>(() =>
    this.components
      .byCategory('whisper')
      .filter((s) => s.state === 'installed')
      .map((s) => ({ value: s.component.id.replace('whisper-', ''), label: s.component.name })),
  );

  /** Every AI model the user can pick right now, across providers. */
  readonly aiChoices = computed<AiChoice[]>(() => {
    const out: AiChoice[] = [];
    for (const s of this.components.byCategory('ai')) {
      if (s.state === 'installed') {
        out.push({ value: `local:${s.component.id}`, label: `${s.component.name} (Local)`, provider: 'local', model: s.component.id });
      }
    }
    for (const m of this.ollamaModels()) {
      out.push({ value: `ollama:${m.id}`, label: `${m.name} (Ollama)`, provider: 'ollama', model: m.id });
    }
    for (const m of CLOUD_MODELS.claude) {
      out.push({ value: `claude:${m.value}`, label: `${m.label} (Claude)`, provider: 'claude', model: m.value });
    }
    for (const m of CLOUD_MODELS.openai) {
      out.push({ value: `openai:${m.value}`, label: `${m.label} (OpenAI)`, provider: 'openai', model: m.value });
    }
    return out;
  });

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
