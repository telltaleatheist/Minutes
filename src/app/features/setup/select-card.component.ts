import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ComponentStatus } from '../../core/models/types';
import { formatSize } from '../../core/utils/format';

/**
 * A single selectable component card in the setup wizard (AI / Whisper / tools).
 * Purely presentational: the checkbox reflects `checked` and emits `toggled`;
 * the parent owns the selection state. Installed/incompatible cards are inert.
 */
@Component({
  selector: 'app-select-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label
      class="select-card"
      [class.disabled]="disabled()"
      [class.checked]="checked()"
      (click)="onClick($event)"
    >
      <input type="checkbox" [checked]="checked()" [disabled]="disabled()" tabindex="-1" />
      <div class="select-info">
        <div class="select-name">
          {{ c().name }}
          @if (c().recommended) {
            <span class="badge badge-rec">Recommended</span>
          }
        </div>
        <div class="select-desc">{{ c().description }}</div>
      </div>
      <div class="select-meta">
        @if (installed()) {
          <span class="badge badge-ok">Installed</span>
        } @else if (incompatible()) {
          <span class="comp-reason" [title]="reasons()">Unavailable</span>
        } @else {
          <span class="select-size">{{ size() }}</span>
        }
      </div>
    </label>
  `,
})
export class SelectCardComponent {
  readonly status = input.required<ComponentStatus>();
  readonly checked = input.required<boolean>();
  readonly toggled = output<void>();

  readonly c = computed(() => this.status().component);
  readonly installed = computed(() => this.status().state === 'installed');
  readonly incompatible = computed(() => this.status().state === 'incompatible');
  readonly disabled = computed(() => this.installed() || this.incompatible());
  readonly reasons = computed(() => (this.status().compatibility.reasons || []).join(' '));
  readonly size = computed(() => formatSize(this.c().sizeBytes));

  onClick(event: Event): void {
    event.preventDefault(); // checkbox state is driven by `checked` input
    if (!this.disabled()) this.toggled.emit();
  }
}
