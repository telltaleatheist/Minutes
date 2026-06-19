import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { ElectronService } from '../../core/services/electron.service';
import { ConfigService } from '../../core/services/config.service';
import { ToastService } from '../../core/services/toast.service';
import { TranscriptionProgress } from '../../core/models/types';
import { formatClock } from '../../core/utils/format';

const ACCEPT = '.wav,.mp3,.m4a,.flac,.ogg,.aac,.wma,.mp4,.mov,.mkv,.webm,.avi';

const GEN_MESSAGES = [
  'Connecting to AI...',
  'Analyzing transcript...',
  'Identifying key topics...',
  'Extracting action items...',
  'Formatting meeting notes...',
  'Finalizing notes...',
];

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

      <div class="processing-steps mt-4">
        <div class="processing-step" [class.active]="transcribing()" [class.completed]="!!transcript()">
          <div class="step-number">1</div>
          <div class="step-content">
            <div class="step-title">Transcribe Audio</div>
            <div class="step-description">Convert audio to text using Whisper AI</div>
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
    </div>

    <div class="panel">
      <div class="panel-header">
        <h2 class="panel-title">Transcript</h2>
        <button class="btn btn-secondary btn-sm" [disabled]="!transcript()" (click)="copy(transcript(), 'Transcript')">
          Copy
        </button>
      </div>
      <div class="notes-output" style="max-height: 200px;">
        @if (transcript()) {
          {{ transcript() }}
        } @else {
          <p class="text-tertiary">Transcript will appear here after transcription...</p>
        }
      </div>
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
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  readonly accept = ACCEPT;

  readonly currentAudioPath = signal('');
  readonly currentFileName = signal('');
  readonly transcript = signal('');
  readonly meetingNotes = signal('');

  readonly transcribing = signal(false);
  readonly generating = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);

  readonly progressVisible = signal(false);
  readonly progressPercent = signal(0);
  readonly progressStatus = signal('Processing...');

  readonly dragOver = signal(false);

  private outputDirectory = '';
  private genInterval: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    // Real transcription progress arrives over IPC (whisper segment stamps + 1s
    // heartbeat). Register once; clean up on destroy.
    const unsub = this.electron.onTranscriptionProgress((d) => this.setTranscriptionProgress(d));
    this.destroyRef.onDestroy(unsub);
    this.destroyRef.onDestroy(() => this.clearGenInterval());

    void this.electron.getDefaultDirectories().then((dirs) => {
      this.outputDirectory = dirs.output || '';
    });
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
    this.toast.show('success', 'File Loaded', `Ready to transcribe: ${this.currentFileName()}`);
  }

  // ─── Transcription ───────────────────────────────────────────────────────────
  async transcribe(): Promise<void> {
    if (!this.currentAudioPath()) return;
    this.transcribing.set(true);
    this.progressVisible.set(true);
    this.setTranscriptionProgress({ percent: 0 });
    try {
      const result = await this.electron.transcribeAudio(
        this.currentAudioPath(),
        this.config.config().whisperModel,
        this.config.config().useGpu,
      );
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
    const percent = Math.max(0, Math.min(100, Math.round(data.percent || 0)));
    this.progressPercent.set(percent);

    let status: string;
    if (data.totalSec && data.processedSec) {
      status = `Transcribing ${formatClock(data.processedSec)} / ${formatClock(data.totalSec)}`;
      if (data.etaSec != null && percent < 100) status += ` · ~${formatClock(data.etaSec)} left`;
    } else if (data.elapsedSec) {
      status = `Transcribing · ${formatClock(data.elapsedSec)} elapsed`;
    } else {
      status = 'Loading Whisper model...';
    }
    this.progressStatus.set(status);
  }

  // ─── Notes generation ────────────────────────────────────────────────────────
  async generate(): Promise<void> {
    if (!this.transcript()) return;
    this.generating.set(true);
    this.progressVisible.set(true);
    this.progressPercent.set(0);
    this.progressStatus.set(GEN_MESSAGES[0]);
    this.startGenInterval();

    const cfg = this.config.config();
    try {
      const result = await this.electron.generateMeetingNotes(this.transcript(), {
        provider: cfg.aiProvider,
        model: cfg.aiModel,
        localModel: cfg.localAiModel,
        ollamaHost: cfg.ollamaHost,
        systemPrompt: cfg.notesPrompt,
        useGpu: cfg.useGpu,
      });
      this.clearGenInterval();
      this.progressPercent.set(100);
      this.progressStatus.set('Notes generated!');
      this.meetingNotes.set(result.notes);
      this.toast.show('success', 'Generation Complete', `Notes generated using ${result.provider}/${result.model}`);
    } catch (err) {
      this.clearGenInterval();
      this.toast.show('error', 'Generation Failed', this.msg(err));
    } finally {
      this.generating.set(false);
      setTimeout(() => this.progressVisible.set(false), 1000);
    }
  }

  private startGenInterval(): void {
    let pct = 0;
    let messageIndex = 0;
    this.genInterval = setInterval(() => {
      if (pct >= 90) return;
      pct += Math.random() * 3;
      if (pct > (messageIndex + 1) * 15 && messageIndex < GEN_MESSAGES.length - 1) messageIndex++;
      this.progressPercent.set(Math.round(Math.min(pct, 90)));
      this.progressStatus.set(GEN_MESSAGES[messageIndex]);
    }, 400);
  }

  private clearGenInterval(): void {
    if (this.genInterval) {
      clearInterval(this.genInterval);
      this.genInterval = null;
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

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
