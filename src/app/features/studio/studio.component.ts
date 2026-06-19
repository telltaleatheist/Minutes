import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { ElectronService } from '../../core/services/electron.service';
import { ConfigService } from '../../core/services/config.service';
import { ModelsService } from '../../core/services/models.service';
import { ToastService } from '../../core/services/toast.service';
import { GenerationProgress, TranscriptionProgress } from '../../core/models/types';
import { formatClock } from '../../core/utils/format';

const ACCEPT = '.wav,.mp3,.m4a,.flac,.ogg,.aac,.wma,.mp4,.mov,.mkv,.webm,.avi';

/**
 * The home screen: drop a file, then transcribe → generate notes → save. Owns
 * its own UI state as signals; all main-process work goes through ElectronService.
 */
@Component({
  selector: 'app-studio',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input
      #fileInput
      type="file"
      [accept]="accept"
      hidden
      (change)="onFileInput($event)"
    />

    <div
      class="drop-zone"
      [class.dragover]="dragOver()"
      (click)="fileInput.click()"
      (dragover)="onDragOver($event)"
      (dragleave)="dragOver.set(false)"
      (drop)="onDrop($event)"
    >
      @if (currentFileName(); as name) {
        <svg viewBox="0 0 24 24">
          <path
            d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"
          />
        </svg>
        <h3>{{ name }}</h3>
        <p>Click or drop to choose a different file</p>
      } @else {
        <svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" /></svg>
        <h3>Drop audio or video here</h3>
        <p>or click to browse your files</p>
        <p class="drop-formats">mp3 · wav · m4a · flac · mp4 · mov · mkv</p>
      }
    </div>

    <div class="panel">
      <div class="panel-header"><h2 class="panel-title">Generate Meeting Notes</h2></div>

      <div class="model-bar">
        <div class="form-group">
          <label class="form-label">Transcription model</label>
          <select class="form-control" [value]="whisperValue()" (change)="onWhisperChange($any($event.target).value)">
            @for (o of models.whisperChoices(); track o.value) {
              <option [value]="o.value">{{ o.label }}</option>
            } @empty {
              <option value="">No models installed</option>
            }
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">AI model</label>
          <select class="form-control" [value]="aiValue()" (change)="onAiChange($any($event.target).value)">
            @for (o of models.aiChoices(); track o.value) {
              <option [value]="o.value">{{ o.label }}</option>
            } @empty {
              <option value="">No AI models available</option>
            }
          </select>
        </div>
      </div>

      <div class="processing-steps mt-4">
        <div class="processing-step" [class.active]="transcribing()" [class.completed]="!!transcript()">
          <div class="step-number">1</div>
          <div class="step-content">
            <div class="step-title">Transcribe Audio</div>
            <div class="step-description">Convert audio to text</div>
          </div>
          <button class="btn btn-primary btn-sm" [disabled]="!currentAudioPath() || transcribing()" (click)="transcribe()">
            @if (transcribing()) {
              <span class="spinner"></span> Transcribing...
            } @else {
              Transcribe
            }
          </button>
        </div>

        <div class="processing-step" [class.active]="generating()" [class.completed]="!!meetingNotes()">
          <div class="step-number">2</div>
          <div class="step-content">
            <div class="step-title">Generate Meeting Notes</div>
            <div class="step-description">Use AI to create structured notes from transcript</div>
          </div>
          <button class="btn btn-primary btn-sm" [disabled]="!transcript() || generating()" (click)="generate()">
            @if (generating()) {
              <span class="spinner"></span> Generating...
            } @else {
              Generate
            }
          </button>
        </div>

        <div class="processing-step" [class.active]="saving()" [class.completed]="saved()">
          <div class="step-number">3</div>
          <div class="step-content">
            <div class="step-title">Save Notes</div>
            <div class="step-description">Save the generated meeting notes to file</div>
          </div>
          <button class="btn btn-success btn-sm" [disabled]="!meetingNotes() || saving()" (click)="save()">
            Save
          </button>
        </div>
      </div>

      @if (progressVisible()) {
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress-fill" [style.width.%]="progressPercent()"></div>
          </div>
          <div class="progress-text">
            <span>{{ progressStatus() }}</span>
            <span>{{ progressPercent() }}%</span>
          </div>
        </div>
      }

      @if (transcribeMs() || generateMs()) {
        <div class="timings">
          @if (transcribeMs()) {
            <span>Transcription <strong>{{ fmtMs(transcribeMs()) }}</strong></span>
          }
          @if (generateMs()) {
            <span>AI synthesis <strong>{{ fmtMs(generateMs()) }}</strong></span>
          }
          @if (transcribeMs() && generateMs()) {
            <span class="timings-total">Total <strong>{{ fmtMs(transcribeMs() + generateMs()) }}</strong></span>
          }
        </div>
      }
    </div>

    <div class="panel">
      <div class="panel-header">
        <h2 class="panel-title">Transcript</h2>
        <button class="btn btn-secondary btn-sm" [disabled]="!transcript()" (click)="copy(transcript(), 'Transcript')">
          Copy
        </button>
      </div>
      <textarea
        class="form-control transcript-input"
        rows="8"
        placeholder="Paste a transcript here, or transcribe an audio file above — then click Generate."
        [value]="transcript()"
        (input)="transcript.set($any($event.target).value)"
      ></textarea>
    </div>

    <div class="panel">
      <div class="panel-header">
        <h2 class="panel-title">Meeting Notes</h2>
        <button class="btn btn-secondary btn-sm" [disabled]="!meetingNotes()" (click)="copy(meetingNotes(), 'Notes')">
          Copy
        </button>
      </div>
      <div class="notes-output">
        @if (meetingNotes()) {
          {{ meetingNotes() }}
        } @else {
          <p class="text-tertiary">Meeting notes will appear here after generation...</p>
        }
      </div>
    </div>
  `,
})
export class StudioComponent implements OnInit {
  private readonly electron = inject(ElectronService);
  private readonly config = inject(ConfigService);
  readonly models = inject(ModelsService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly accept = ACCEPT;

  // Quick model pickers (reflect & persist the saved defaults).
  readonly whisperValue = computed(() => this.config.config().whisperModel);
  readonly aiValue = computed(() => this.models.currentAiValue(this.config.config()));

  onWhisperChange(value: string): void {
    void this.config.save({ whisperModel: value });
  }
  onAiChange(value: string): void {
    void this.config.save(this.models.patchForAi(value));
  }

  readonly currentAudioPath = signal('');
  readonly currentFileName = signal('');
  readonly transcript = signal('');
  readonly meetingNotes = signal('');

  readonly transcribing = signal(false);
  readonly generating = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);

  // Elapsed time (ms) for the last transcription / AI synthesis. 0 = not run yet.
  readonly transcribeMs = signal(0);
  readonly generateMs = signal(0);

  readonly progressVisible = signal(false);
  readonly progressPercent = signal(0);
  readonly progressStatus = signal('Processing...');

  readonly dragOver = signal(false);

  private outputDirectory = '';
  private lastAudioSec = 0; // most recent audio duration seen during transcription

  ngOnInit(): void {
    // Real progress arrives over IPC — transcription (whisper segment stamps +
    // 1s heartbeat) and generation (per-topic synthesis steps). Register once.
    this.destroyRef.onDestroy(this.electron.onTranscriptionProgress((d) => this.setTranscriptionProgress(d)));
    this.destroyRef.onDestroy(this.electron.onGenerationProgress((d) => this.setGenerationProgress(d)));

    void this.electron.getDefaultDirectories().then((dirs) => {
      this.outputDirectory = dirs.output || '';
    });
  }

  private setGenerationProgress(d: GenerationProgress): void {
    this.progressPercent.set(Math.max(0, Math.min(100, Math.round(d.percent || 0))));
    this.progressStatus.set(d.message || 'Generating…');
  }

  // ─── File loading ────────────────────────────────────────────────────────────
  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] as (File & { path?: string }) | undefined;
    if (file?.path) this.loadFile(file.path);
    input.value = ''; // allow re-selecting the same file
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    const file = event.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined;
    if (file?.path) this.loadFile(file.path);
  }

  private loadFile(path: string): void {
    this.currentAudioPath.set(path);
    this.currentFileName.set(path.split(/[\\/]/).pop() || path);
    this.transcript.set('');
    this.meetingNotes.set('');
    this.saved.set(false);
    this.transcribeMs.set(0);
    this.generateMs.set(0);
    this.toast.show('success', 'File Loaded', `Ready to transcribe: ${this.currentFileName()}`);
  }

  // ─── Transcription ───────────────────────────────────────────────────────────
  async transcribe(): Promise<void> {
    if (!this.currentAudioPath()) return;
    this.transcribing.set(true);
    this.progressVisible.set(true);
    this.setTranscriptionProgress({ percent: 0 });
    this.lastAudioSec = 0;
    const model = this.config.config().whisperModel;
    const useGpu = this.config.config().useGpu;
    const start = Date.now();
    try {
      const result = await this.electron.transcribeAudio(this.currentAudioPath(), model, useGpu);
      const elapsedMs = Date.now() - start;
      this.transcribeMs.set(elapsedMs);
      void this.calibrateSpeed(model, useGpu, elapsedMs);
      this.setTranscriptionProgress({ percent: 100, totalSec: 1, processedSec: 1, etaSec: 0 });
      this.transcript.set(result.transcript);
      this.toast.show('success', 'Transcription Complete', 'Audio has been transcribed successfully');
    } catch (err) {
      this.toast.show('error', 'Transcription Failed', this.msg(err));
    } finally {
      this.transcribing.set(false);
      setTimeout(() => this.progressVisible.set(false), 1000);
    }
  }

  private setTranscriptionProgress(data: TranscriptionProgress): void {
    if (data.totalSec && data.totalSec > 1) this.lastAudioSec = data.totalSec;
    const percent = Math.max(0, Math.min(100, Math.round(data.percent || 0)));
    this.progressPercent.set(percent);

    let status: string;
    if (data.totalSec && data.processedSec) {
      status = `Transcribing ${formatClock(data.processedSec)} / ${formatClock(data.totalSec)}`;
      if (data.etaSec != null && percent < 100) status += ` · ~${formatClock(data.etaSec)} left`;
    } else if (data.elapsedSec) {
      status = `Transcribing · ${formatClock(data.elapsedSec)} elapsed`;
    } else {
      status = 'Loading transcription model...';
    }
    this.progressStatus.set(status);
  }

  // ─── Notes generation ────────────────────────────────────────────────────────
  async generate(): Promise<void> {
    if (!this.transcript()) return;
    this.generating.set(true);
    this.progressVisible.set(true);
    this.progressPercent.set(0);
    this.progressStatus.set('Finding topics…');

    const cfg = this.config.config();
    const start = Date.now();
    try {
      const result = await this.electron.generateMeetingNotes(this.transcript(), {
        provider: cfg.aiProvider,
        model: cfg.aiModel,
        localModel: cfg.localAiModel,
        ollamaHost: cfg.ollamaHost,
        systemPrompt: cfg.notesPrompt,
        useGpu: cfg.useGpu,
      });
      this.generateMs.set(Date.now() - start);
      this.progressPercent.set(100);
      this.progressStatus.set('Notes generated!');
      this.meetingNotes.set(result.notes);
      this.toast.show('success', 'Generation Complete', `Notes generated using ${result.provider}/${result.model}`);
    } catch (err) {
      this.toast.show('error', 'Generation Failed', this.msg(err));
    } finally {
      this.generating.set(false);
      setTimeout(() => this.progressVisible.set(false), 1000);
    }
  }

  // ─── Save ────────────────────────────────────────────────────────────────────
  async save(): Promise<void> {
    if (!this.meetingNotes()) return;
    this.saving.set(true);
    try {
      const date = new Date().toISOString().split('T')[0];
      const filename = `Meeting Notes - ${date}.md`;
      const outputPath = `${this.outputDirectory}/${filename}`;
      const result = await this.electron.saveNotes(this.meetingNotes(), outputPath);
      if (result.success) {
        this.saved.set(true);
        this.toast.show('success', 'Saved', `Notes saved to ${filename}`);
        void this.electron.openFolder(this.outputDirectory);
      } else {
        this.toast.show('error', 'Save Failed', result.error || 'Unknown error');
      }
    } catch (err) {
      this.toast.show('error', 'Save Failed', this.msg(err));
    } finally {
      this.saving.set(false);
    }
  }

  // ─── Misc ────────────────────────────────────────────────────────────────────
  copy(text: string, name: string): void {
    navigator.clipboard
      .writeText(text)
      .then(() => this.toast.show('success', 'Copied', `${name} copied to clipboard`))
      .catch(() => this.toast.show('error', 'Error', 'Failed to copy to clipboard'));
  }

  fmtMs(ms: number): string {
    return formatClock(Math.round(ms / 1000));
  }

  /** Record the measured real-time factor so the model picker shows a real,
   *  personalized speed estimate next time. No-op if we never saw a duration. */
  private async calibrateSpeed(model: string, useGpu: boolean, elapsedMs: number): Promise<void> {
    if (this.lastAudioSec <= 1) return;
    const rtf = elapsedMs / 1000 / this.lastAudioSec;
    if (!isFinite(rtf) || rtf <= 0) return;
    const key = `${model}|${useGpu ? 'gpu' : 'cpu'}`;
    const map = { ...(this.config.config().transcriptionRtf ?? {}), [key]: rtf };
    await this.config.save({ transcriptionRtf: map });
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
