import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { CronJob, CronStore } from './types.js';

/**
 * Where scheduled jobs are kept.
 *
 * `AICO_CRON_STORE` overrides it, for the same reason the work ledger has an
 * override: a live test that exercises the real scheduler must not write real
 * jobs into the user's own store. Without this, a probe that creates a job
 * running "every minute" leaves it there — firing forever, on their machine,
 * long after the test has finished.
 */
const STORE_PATH = process.env.AICO_CRON_STORE?.trim()
  || path.join(os.homedir(), '.aico', 'cron.json');

async function readStore(): Promise<CronStore> {
  if (!existsSync(STORE_PATH)) return { jobs: [], version: 1 };
  try {
    const text = await readFile(STORE_PATH, 'utf8');
    return JSON.parse(text) as CronStore;
  } catch {
    return { jobs: [], version: 1 };
  }
}

async function writeStore(store: CronStore): Promise<void> {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  // Atomic write: write to temp file then rename
  const tmpPath = STORE_PATH + '.tmp';
  await writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  // On Windows, rename over existing file requires unlinking first
  try {
    const { rename } = await import('fs/promises');
    await rename(tmpPath, STORE_PATH);
  } catch {
    // Fallback: direct write
    await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  }
}

export async function loadCronStore(): Promise<CronJob[]> {
  const store = await readStore();
  return store.jobs;
}

export async function persistJob(job: CronJob): Promise<void> {
  const store = await readStore();
  const idx = store.jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    store.jobs[idx] = job;
  } else {
    store.jobs.push(job);
  }
  await writeStore(store);
}

export async function removePersistedJob(id: string): Promise<void> {
  const store = await readStore();
  store.jobs = store.jobs.filter((j) => j.id !== id);
  await writeStore(store);
}
