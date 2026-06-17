import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SetupService } from '../../core/services/setup.service';

/**
 * The corner download dock: an ambient progress widget shown while components
 * install. Subscribes to SetupService's download queue; mirrors the original
 * renderer's dock, now declarative.
 */
@Component({
  selector: 'app-download-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="dock">
        <div class="dock-header-row">
          <button class="dock-head" (click)="setup.dockExpanded.set(!setup.dockExpanded())">
            <span
              class="dock-icon"
              [class.dock-spinner]="running()"
              [class.dock-check]="!running() && failed() === 0"
              [class.dock-warn]="!running() && failed() > 0"
              >{{ running() ? '' : failed() > 0 ? '!' : '✓' }}</span
            >
            <span class="dock-title">{{ title() }}</span>
            <span class="dock-chevron">{{ setup.dockExpanded() ? '▾' : '▸' }}</span>
          </button>
          <button class="dock-dismiss" title="Dismiss" (click)="setup.dockDismissed.set(true)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path
                d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </div>

        @if (running()) {
          <div class="dock-aggregate">
            <div class="dock-bar"><div class="dock-fill" [style.width.%]="aggPct()"></div></div>
          </div>
        }

        @if (setup.dockExpanded()) {
          <div class="dock-body">
            @for (d of items(); track d.id) {
              <div class="dock-item" [attr.data-status]="d.state">
                <span class="di-name" [title]="d.name">{{ d.name }}</span>
                @switch (d.state) {
                  @case ('done') {
                    <span class="di-done">✓</span>
                  }
                  @case ('failed') {
                    <span class="di-failed" [title]="d.message">Failed</span>
                  }
                  @default {
                    <div class="di-bar"><div class="di-fill" [style.width.%]="d.pct"></div></div>
                    <span class="di-pct">{{ d.state === 'queued' ? 'Queued' : d.pct + '%' }}</span>
                  }
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class DownloadDockComponent {
  readonly setup = inject(SetupService);

  readonly items = computed(() => Object.values(this.setup.downloads()));
  readonly visible = computed(() => !this.setup.dockDismissed() && this.items().length > 0);
  readonly running = computed(() =>
    this.items().some((d) => d.state === 'downloading' || d.state === 'queued'),
  );
  readonly done = computed(() => this.items().filter((d) => d.state === 'done').length);
  readonly failed = computed(() => this.items().filter((d) => d.state === 'failed').length);
  readonly total = computed(() => this.items().length);

  readonly aggPct = computed(() => {
    const it = this.items();
    if (!it.length) return 0;
    const sum = it.reduce((s, d) => s + (d.state === 'done' ? 100 : d.pct || 0), 0);
    return Math.round(sum / it.length);
  });

  readonly title = computed(() => {
    if (this.running()) return `Downloading ${this.done()}/${this.total()}…`;
    if (this.failed() > 0) return `${this.done()}/${this.total()} done · ${this.failed()} failed`;
    return 'Downloads complete';
  });
}
