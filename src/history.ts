import { readFile, writeFile, mkdir, readdir, rename, stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  id: string;
  cwd: string;
  model: string;
  startedAt: number;
  messages: Message[];
  name?: string;
}

export function generateSessionId(): string {
  return crypto.randomBytes(3).toString('hex');
}

export function getSessionDir(cwd: string): string {
  const hash = Buffer.from(cwd).toString('base64').replace(/[/+=]/g, '_');
  return path.join(os.homedir(), '.aico', 'projects', hash, 'sessions');
}

function sessionFilePath(sessionId: string, cwd: string): string {
  return path.join(getSessionDir(cwd), `${sessionId}.jsonl`);
}

export async function saveSession(session: Session): Promise<void> {
  const dir = getSessionDir(session.cwd);
  await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: 'session_start',
      id: session.id,
      model: session.model,
      cwd: session.cwd,
      startedAt: session.startedAt,
    }),
  );
  for (const msg of session.messages) {
    lines.push(JSON.stringify({ type: 'message', ...msg }));
  }
  // Atomic write: write to temp file, then rename
  const filePath = sessionFilePath(session.id, session.cwd);
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, lines.join('\n') + '\n');
  await rename(tmpPath, filePath);
}

export async function loadSession(id: string, cwd: string): Promise<Session | null> {
  try {
    const filePath = sessionFilePath(id, cwd);

    // Warn if session file is very large (> 5MB)
    try {
      const info = await stat(filePath);
      if (info.size > 5 * 1024 * 1024) {
        console.warn(`  ⚠ Session ${id} is ${(info.size / 1024 / 1024).toFixed(1)}MB — consider using /compact`);
      }
    } catch { /* stat failed — file might not exist */ }

    const text = await readFile(filePath, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const session: Session = { id, cwd, model: '', startedAt: 0, messages: [] };
    let skipped = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === 'session_start') {
          session.model = String(obj.model ?? '');
          session.startedAt = Number(obj.startedAt ?? 0);
        } else if (obj.type === 'message') {
          session.messages.push({
            role: obj.role as 'user' | 'assistant',
            content: String(obj.content ?? ''),
            timestamp: Number(obj.timestamp ?? 0),
          });
        }
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) {
      console.warn(`  ⚠ Session ${id}: ${skipped} corrupted line(s) skipped`);
    }
    return session;
  } catch {
    return null;
  }
}

export async function listSessions(
  cwd: string,
): Promise<Array<{ id: string; startedAt: number; messageCount: number; model: string }>> {
  const dir = getSessionDir(cwd);
  try {
    const files = await readdir(dir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    const results: Array<{ id: string; startedAt: number; messageCount: number; model: string }> =
      [];
    for (const file of jsonlFiles) {
      const id = file.replace('.jsonl', '');
      const session = await loadSession(id, cwd);
      if (session) {
        results.push({
          id: session.id,
          startedAt: session.startedAt,
          messageCount: session.messages.length,
          model: session.model,
        });
      }
    }
    results.sort((a, b) => b.startedAt - a.startedAt);
    return results;
  } catch {
    return [];
  }
}

export async function appendMessage(
  sessionId: string,
  cwd: string,
  msg: Message,
): Promise<void> {
  const dir = getSessionDir(cwd);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ type: 'message', ...msg }) + '\n';
  const { appendFile } = await import('fs/promises');
  await appendFile(sessionFilePath(sessionId, cwd), line);
}

/** Load the most recent session for --continue */
export async function loadLastSession(cwd: string): Promise<Session | null> {
  const sessions = await listSessions(cwd);
  if (sessions.length === 0) return null;
  return loadSession(sessions[0].id, cwd);
}