/**
 * Studio Kanban tracker — JSON-file storage (no native dependencies).
 * Tracks features, iterations, and heal attempts per studio run.
 * Data lives in {projectDir}/.studio/kanban.json (plain JSON, atomic writes).
 */

import { readFile, writeFile, rename, unlink } from 'fs/promises';
import path from 'path';
import { studioDir } from './state.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type FeatureStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'blocked';
export type IterationResult = 'success' | 'healed' | 'failed';
export type HealStrategy = 'retry' | 'simplify' | 'replan';

export interface Feature {
  id: string;
  name: string;
  description?: string;
  status: FeatureStatus;
  ownerAgent?: string;
  phase: number;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
  errorDetail?: string;
}

export interface Iteration {
  id: number;
  phase: number;
  iteration: number;
  agentType: string;
  startedAt: number;
  completedAt?: number;
  result?: IterationResult;
  errorCount: number;
}

export interface HealAttempt {
  id: number;
  phase: number;
  attempt: number;
  strategy: HealStrategy;
  errorType: string;
  errorDetail: string;
  success: boolean;
  timestamp: number;
}

interface KanbanData {
  features: Feature[];
  iterations: Iteration[];
  healAttempts: HealAttempt[];
  nextIterationId: number;
  nextHealId: number;
}

// ── StudioTracker ─────────────────────────────────────────────────────────────

export class StudioTracker {
  private readonly dbPath: string;
  private data: KanbanData;

  constructor(projectDir: string) {
    this.dbPath = path.join(studioDir(projectDir), 'kanban.json');
    this.data = { features: [], iterations: [], healAttempts: [], nextIterationId: 1, nextHealId: 1 };
    this.loadSync();
  }

  private loadSync(): void {
    try {
      const { readFileSync } = require('fs');
      const raw = readFileSync(this.dbPath, 'utf8') as string;
      this.data = JSON.parse(raw) as KanbanData;
    } catch {
      // Start fresh if file doesn't exist
    }
  }

  private async save(): Promise<void> {
    const tmpPath = this.dbPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
    if (process.platform === 'win32') {
      try { await unlink(this.dbPath); } catch { /* ok */ }
    }
    await rename(tmpPath, this.dbPath);
  }

  // ── Features ──────────────────────────────────────────────────────────────

  upsertFeature(feature: Omit<Feature, 'createdAt' | 'updatedAt'>): void {
    const now = Date.now();
    const existing = this.data.features.find(f => f.id === feature.id);
    if (existing) {
      Object.assign(existing, { ...feature, updatedAt: now });
    } else {
      this.data.features.push({ ...feature, createdAt: now, updatedAt: now });
    }
    // Fire-and-forget save (synchronous interface, async storage)
    void this.save();
  }

  updateFeatureStatus(id: string, status: FeatureStatus, errorDetail?: string): void {
    const feature = this.data.features.find(f => f.id === id);
    if (feature) {
      feature.status = status;
      feature.updatedAt = Date.now();
      if (errorDetail !== undefined) feature.errorDetail = errorDetail;
      void this.save();
    }
  }

  getFeature(id: string): Feature | null {
    return this.data.features.find(f => f.id === id) ?? null;
  }

  getFeaturesByPhase(phase: number): Feature[] {
    return this.data.features.filter(f => f.phase === phase);
  }

  getFeaturesByStatus(status: FeatureStatus): Feature[] {
    return this.data.features.filter(f => f.status === status);
  }

  // ── Iterations ────────────────────────────────────────────────────────────

  startIteration(phase: number, iteration: number, agentType: string): number {
    const id = this.data.nextIterationId++;
    this.data.iterations.push({ id, phase, iteration, agentType, startedAt: Date.now(), errorCount: 0 });
    void this.save();
    return id;
  }

  completeIteration(id: number, result: IterationResult, errorCount: number): void {
    const iter = this.data.iterations.find(i => i.id === id);
    if (iter) {
      iter.completedAt = Date.now();
      iter.result = result;
      iter.errorCount = errorCount;
      void this.save();
    }
  }

  getIterationsByPhase(phase: number): Iteration[] {
    return this.data.iterations.filter(i => i.phase === phase);
  }

  // ── Heal attempts ─────────────────────────────────────────────────────────

  recordHealAttempt(attempt: Omit<HealAttempt, 'id' | 'timestamp'>): void {
    const id = this.data.nextHealId++;
    this.data.healAttempts.push({ ...attempt, id, timestamp: Date.now() });
    void this.save();
  }

  getHealAttempts(phase?: number): HealAttempt[] {
    return phase !== undefined
      ? this.data.healAttempts.filter(h => h.phase === phase)
      : this.data.healAttempts;
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  getSummary(): {
    totalFeatures: number;
    complete: number;
    failed: number;
    pending: number;
    totalIterations: number;
    totalHealAttempts: number;
    successfulHeals: number;
  } {
    const f = this.data.features;
    return {
      totalFeatures: f.length,
      complete: f.filter(x => x.status === 'complete').length,
      failed: f.filter(x => x.status === 'failed').length,
      pending: f.filter(x => x.status === 'pending' || x.status === 'in_progress').length,
      totalIterations: this.data.iterations.length,
      totalHealAttempts: this.data.healAttempts.length,
      successfulHeals: this.data.healAttempts.filter(h => h.success).length,
    };
  }

  close(): void {
    // No-op — JSON tracker doesn't hold open file handles
  }
}
