import { inject, Injectable, signal } from '@angular/core';
import { ElectronService } from './electron.service';
import { ComponentStatus, SystemProfile } from '../models/types';

/** Catalog × installed × compatibility status for the setup wizard. */
@Injectable({ providedIn: 'root' })
export class ComponentService {
  private readonly electron = inject(ElectronService);
  readonly statuses = signal<ComponentStatus[]>([]);
  readonly system = signal<SystemProfile | null>(null);

  async refreshSystem(): Promise<void> {
    try {
      this.system.set(await this.electron.detectSystem());
    } catch {
      this.system.set(null);
    }
  }

  async refresh(): Promise<void> {
    try {
      this.statuses.set(await this.electron.listComponents());
    } catch {
      this.statuses.set([]);
    }
  }

  statusOf(id: string): ComponentStatus | undefined {
    return this.statuses().find((s) => s.component.id === id);
  }

  byCategory(category: string): ComponentStatus[] {
    return this.statuses().filter((s) => s.component.category === category);
  }
}
