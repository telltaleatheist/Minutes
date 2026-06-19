import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { StudioComponent } from './features/studio/studio.component';
import { SetupWizardComponent } from './features/setup/setup-wizard.component';
import { SettingsComponent } from './features/settings/settings.component';
import { DownloadDockComponent } from './components/download-dock/download-dock.component';
import { ToastHostComponent } from './components/toast-host/toast-host.component';
import { ThemeService } from './core/services/theme.service';
import { ConfigService } from './core/services/config.service';
import { ComponentService } from './core/services/component.service';
import { SetupService } from './core/services/setup.service';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    StudioComponent,
    SetupWizardComponent,
    SettingsComponent,
    DownloadDockComponent,
    ToastHostComponent,
  ],
  template: `
    <nav class="nav">
      <div class="nav-brand">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4 14H9c-.55 0-1-.45-1-1s.45-1 1-1h6c.55 0 1 .45 1 1s-.45 1-1 1zm2-4H7c-.55 0-1-.45-1-1s.45-1 1-1h10c.55 0 1 .45 1 1s-.45 1-1 1zm0-4H7c-.55 0-1-.45-1-1s.45-1 1-1h10c.55 0 1 .45 1 1s-.45 1-1 1z"
          />
        </svg>
        <h1>Minutes</h1>
      </div>
      <div class="nav-actions">
        <button class="btn btn-ghost btn-icon" title="Downloads" (click)="setup.openWizard(true)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
          </svg>
        </button>
        <button class="btn btn-ghost btn-icon" title="Settings" (click)="setup.openSettings()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
            />
          </svg>
        </button>
        <button class="btn btn-ghost btn-icon" title="Toggle Theme" (click)="theme.toggle()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"
            />
          </svg>
        </button>
      </div>
    </nav>

    <div class="container">
      <app-studio />
    </div>

    <app-setup-wizard />
    <app-settings />
    <app-download-dock />
    <app-toast-host />
  `,
})
export class App implements OnInit {
  readonly theme = inject(ThemeService);
  readonly setup = inject(SetupService);
  private readonly config = inject(ConfigService);
  private readonly components = inject(ComponentService);

  async ngOnInit(): Promise<void> {
    this.theme.init();
    await this.config.load();
    await this.components.refreshSystem();
    await this.components.refresh();

    // Gate: hold on the wizard until setup is finished AND required tools exist.
    if (!this.config.config().setupComplete || !this.setup.requiredInstalled()) {
      this.setup.openWizard(false);
    }
  }
}
