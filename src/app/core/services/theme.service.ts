import { Injectable, signal } from '@angular/core';

export type Theme = 'dark' | 'light';

/**
 * Dark/light theme. The storage key stays 'boardnotes-theme' so a returning
 * user's saved preference carries over from the pre-rename build. The attribute
 * is set on <body> to match the ported stylesheet's [data-theme="…"] selectors.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private static readonly KEY = 'boardnotes-theme';
  readonly theme = signal<Theme>('dark');

  init(): void {
    const saved = (localStorage.getItem(ThemeService.KEY) as Theme | null) ?? 'dark';
    this.set(saved);
  }

  set(theme: Theme): void {
    this.theme.set(theme);
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem(ThemeService.KEY, theme);
  }

  toggle(): void {
    this.set(this.theme() === 'dark' ? 'light' : 'dark');
  }
}
