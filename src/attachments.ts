/**
 * Attachment helpers for aico.
 *
 * Supports:
 *  - @attach <path>  — attach a file, image, or directory by path
 *  - Clipboard image — read an image copied to the system clipboard
 *
 * SDK attachment types:
 *   { type: "directory", path }               — let the model browse a directory
 *   { type: "file",      path }               — text/code file read by SDK
 *   { type: "blob", data, mimeType }          — binary / image uploaded inline
 */
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type SdkAttachment =
  | { type: 'directory'; path: string; displayName?: string }
  | { type: 'file';      path: string; displayName?: string }
  | { type: 'blob';      data: string; mimeType: string; displayName?: string };

export interface ResolvedAttachment {
  sdkAttachment: SdkAttachment;
  /** Short display label shown in the UI */
  label: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const TEXT_EXTS  = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.py', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.java', '.rb', '.sh', '.bash', '.zsh',
  '.yaml', '.yml', '.toml', '.ini', '.env', '.sql', '.html', '.css', '.scss',
]);

function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.bmp':  'image/bmp',
    '.svg':  'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Parse "@attach <path>" tokens out of a prompt string.
 * Handles quoted paths (for spaces) and unquoted tokens.
 *   @attach "/path/with spaces/file.txt"
 *   @attach './relative/dir'
 *   @attach src/index.ts
 * Returns the cleaned prompt and the list of resolved path strings.
 */
export function parseAttachTokens(prompt: string): { prompt: string; paths: string[] } {
  const paths: string[] = [];
  // Match: @attach "...", @attach '...', or @attach non-space-token
  const cleaned = prompt
    .replace(/@attach\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g, (_full, dq, sq, bare) => {
      paths.push(dq ?? sq ?? bare);
      return '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { prompt: cleaned, paths };
}

/**
 * Resolve a file-system path to a SdkAttachment.
 *
 * Detection order:
 *   1. Directory          → { type: "directory", path }   (model can browse)
 *   2. Image file         → { type: "blob", data, mimeType } (uploaded inline)
 *   3. Text / code file   → { type: "file",  path }       (SDK reads directly)
 *   4. Unknown extension  → { type: "file",  path }       (SDK best-effort)
 */
/** Max attachment file size: 10MB */
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

/** Check if a file is likely binary by reading first 8KB and looking for null bytes */
async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const fd = await import('fs/promises').then(m => m.open(filePath, 'r'));
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buf, 0, 8192, 0);
    await fd.close();
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true; // null byte = binary
    }
    return false;
  } catch {
    return false;
  }
}

export async function resolveFileAttachment(
  filePath: string,
  cwd: string,
): Promise<ResolvedAttachment | null> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  if (!existsSync(abs)) return null;

  const info = await stat(abs);

  // ── Directory ──────────────────────────────────────────────────────────────
  if (info.isDirectory()) {
    const label = path.basename(abs) || abs;
    return {
      label: `📁 ${label}/`,
      sdkAttachment: { type: 'directory', path: abs, displayName: label },
    };
  }

  // ── Size guard ─────────────────────────────────────────────────────────────
  if (info.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(
      `File too large: ${path.basename(abs)} is ${(info.size / 1024 / 1024).toFixed(1)}MB ` +
      `(max ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB)`,
    );
  }

  const ext   = path.extname(abs).toLowerCase();
  const label = path.basename(abs);

  // ── Image → inline blob ────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    const data = await readFile(abs);
    return {
      label: `🖼 ${label}`,
      sdkAttachment: {
        type: 'blob',
        data: data.toString('base64'),
        mimeType: mimeForExt(ext),
        displayName: label,
      },
    };
  }

  // ── Binary detection — don't upload binary files as text ───────────────────
  if (!TEXT_EXTS.has(ext) && await isBinaryFile(abs)) {
    throw new Error(
      `File appears to be binary: ${label}. Only text/code files and images can be attached.`,
    );
  }

  // ── Text / code / unknown → file path reference ───────────────────────────
  return {
    label: `📄 ${label}`,
    sdkAttachment: { type: 'file', path: abs, displayName: label },
  };
}

// ── Clipboard image reading ──────────────────────────────────────

/**
 * Try to read an image from the system clipboard.
 * Returns null if the clipboard has no image or clipboard access is unavailable.
 *
 * Strategy:
 *   Windows: PowerShell Get-Clipboard -Format Image → save to temp file → base64
 *   macOS:   osascript to check clipboard type, then pngpaste or pbpaste
 *   Linux:   xclip -selection clipboard -t image/png
 */
export async function readClipboardImage(): Promise<ResolvedAttachment | null> {
  const platform = process.platform;

  if (platform === 'win32') return readClipboardImageWindows();
  if (platform === 'darwin') return readClipboardImageMac();
  return readClipboardImageLinux();
}

async function readClipboardImageWindows(): Promise<ResolvedAttachment | null> {
  try {
    // PowerShell snippet: check if clipboard has image; if yes, save to temp and print path
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms;
      $img = [System.Windows.Forms.Clipboard]::GetImage();
      if ($img -eq $null) { exit 1 }
      $tmp = [System.IO.Path]::GetTempFileName() -replace '\\.tmp$','.png';
      $img.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png);
      Write-Output $tmp;
    `;
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', ps,
    ], { timeout: 8_000 });
    const tmpPath = stdout.trim();
    if (!tmpPath || !existsSync(tmpPath)) return null;

    const data = await readFile(tmpPath);
    // Clean up temp file
    import('fs/promises').then(m => m.unlink(tmpPath)).catch(() => {});

    return {
      label: '📋 clipboard image',
      sdkAttachment: {
        type: 'blob',
        data: data.toString('base64'),
        mimeType: 'image/png',
        displayName: 'clipboard.png',
      },
    };
  } catch {
    return null;
  }
}

async function readClipboardImageMac(): Promise<ResolvedAttachment | null> {
  try {
    // pngpaste writes to a file if clipboard has image, exits 1 otherwise
    const tmpPath = `/tmp/aico_clipboard_${Date.now()}.png`;
    await execFileAsync('pngpaste', [tmpPath], { timeout: 5_000 });
    const data = await readFile(tmpPath);
    import('fs/promises').then(m => m.unlink(tmpPath)).catch(() => {});
    return {
      label: '📋 clipboard image',
      sdkAttachment: {
        type: 'blob',
        data: data.toString('base64'),
        mimeType: 'image/png',
        displayName: 'clipboard.png',
      },
    };
  } catch {
    return null;
  }
}

async function readClipboardImageLinux(): Promise<ResolvedAttachment | null> {
  try {
    const { stdout } = await execFileAsync(
      'xclip',
      ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      { encoding: 'buffer', timeout: 5_000 },
    );
    if (!stdout || (stdout as Buffer).length === 0) return null;
    return {
      label: '📋 clipboard image',
      sdkAttachment: {
        type: 'blob',
        data: (stdout as unknown as Buffer).toString('base64'),
        mimeType: 'image/png',
        displayName: 'clipboard.png',
      },
    };
  } catch {
    return null;
  }
}
