/**
 * Running an app (or its checks) inside a container when the native toolchain
 * is missing: the argv builder, and nothing else.
 *
 * Why a separate, tiny module: this is the one place an app's manifest reaches
 * `docker run`, so the rules that keep it from being a way out of the app
 * directory live here where they can be read in one screen and tested without
 * Docker (ADR 0031 section 4 and its threat model):
 *
 *   - the volume source is the app directory the *engine* computed — never a
 *     value from the manifest;
 *   - the image must look like an image reference, cache paths like absolute
 *     container paths; both are validated again here, not only at load;
 *   - the only published port is 127.0.0.1:<host>:<container>;
 *   - no `--privileged`, no host network, no Docker socket, no other mounts,
 *     no flags from the manifest at all;
 *   - environment is passed as `-e KEY=VALUE` for non-secret declared values
 *     only; the parent's environment is not forwarded.
 *
 * Why argv and no shell: on Windows `shell: true` re-joins arguments without
 * quoting, which breaks `sh -c "a && b"`. `docker` is an executable, so it is
 * spawned directly.
 *
 * What it does not do: pull images, build them, or decide *whether* to use a
 * container — the caller asks for it explicitly (`docker: true`).
 *
 * @module apps/docker-run
 */

import crypto from 'crypto';
import { spawnSync } from 'child_process';

/** How docker is invoked. Tests point this at a fake; production is plain `docker`. */
let dockerCommand: { file: string; prefix: string[] } = { file: 'docker', prefix: [] };

/** Test hook: route every docker call through another executable (a node script). */
export function setDockerCommandForTests(cmd: { file: string; prefix?: string[] } | undefined): void {
  readyCache = undefined;
  dockerCommand = cmd ? { file: cmd.file, prefix: cmd.prefix ?? [] } : { file: 'docker', prefix: [] };
}

/** The executable and leading args for a docker call. */
export function dockerBase(): { file: string; prefix: string[] } {
  return dockerCommand;
}

const IMAGE = /^[a-z0-9][a-z0-9._/:@-]*$/i;
const CONTAINER_PATH = /^\/[A-Za-z0-9_./-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidImage(image: string): boolean {
  return IMAGE.test(image) && !image.startsWith('-');
}

/** A stable named volume for one dependency cache of one app. */
export function cacheVolumeName(slug: string, containerPath: string): string {
  return `aico-${slug}-${crypto.createHash('sha1').update(containerPath).digest('hex').slice(0, 8)}`;
}

/** A container name unique to this launch. */
export function containerName(slug: string): string {
  return `aico-${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

export interface DockerRunInput {
  slug: string;
  /** The app directory, computed by the engine. */
  dir: string;
  image: string;
  /** What to run inside, via `sh -c`. */
  command: string;
  /** Run once first, in the same shell (`setup && command`). */
  setup?: string;
  /** Non-secret environment for the process. */
  env?: Record<string, string>;
  /** Publish container port on 127.0.0.1:<hostPort>. Omit for a one-shot check. */
  port?: { host: number; container: number };
  cache?: string[];
  name?: string;
}

export interface DockerRunPlan {
  file: string;
  args: string[];
  name: string;
}

/**
 * The `docker run` for an app. Throws on anything a manifest may not ask for,
 * so a bad value is refused rather than quietly dropped.
 */
export function dockerRunPlan(input: DockerRunInput): DockerRunPlan {
  if (!isValidImage(input.image)) throw new Error(`"${input.image}" is not a valid image reference`);
  const name = input.name ?? containerName(input.slug);
  const args = [...dockerBase().prefix, 'run', '--rm', '--name', name, '--init',
    '-v', `${input.dir}:/work`, '-w', '/work'];
  for (const cachePath of input.cache ?? []) {
    if (!CONTAINER_PATH.test(cachePath)) throw new Error(`cache path "${cachePath}" must be an absolute container path`);
    args.push('-v', `${cacheVolumeName(input.slug, cachePath)}:${cachePath}`);
  }
  if (input.port) {
    if (!Number.isInteger(input.port.host) || !Number.isInteger(input.port.container)) throw new Error('ports must be integers');
    args.push('-p', `127.0.0.1:${input.port.host}:${input.port.container}`);
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!ENV_KEY.test(key)) throw new Error(`"${key}" is not a valid environment variable name`);
    args.push('-e', `${key}=${value}`);
  }
  const script = input.setup ? `${input.setup} && ${input.command}` : input.command;
  args.push(input.image, 'sh', '-c', script);
  return { file: dockerBase().file, args, name };
}

/** `docker rm -f <name>` argv, for stopping a container whose client process was killed. */
export function dockerRemovePlan(name: string): { file: string; args: string[] } {
  return { file: dockerBase().file, args: [...dockerBase().prefix, 'rm', '-f', name] };
}

let readyCache: { at: number; value: { ok: boolean; message: string } } | undefined;

/** Whether the Docker daemon answers (installed is not the same as running). Reused for 15 seconds. */
export function dockerReady(run: typeof spawnSync = spawnSync): { ok: boolean; message: string } {
  const injected = run !== spawnSync;
  if (!injected && readyCache && Date.now() - readyCache.at < 15_000) return readyCache.value;
  const { file, prefix } = dockerBase();
  const r = run(file, [...prefix, 'info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const value = r.status === 0 ? { ok: true, message: '' }
    : r.error ? { ok: false, message: 'Docker is not installed (the docker command was not found). Install it from https://docs.docker.com/get-docker/' }
      : { ok: false, message: 'Docker is installed but its engine is not running. Start Docker Desktop (or the docker service) and try again.' };
  if (!injected) readyCache = { at: Date.now(), value };
  return value;
}

/** Forget the cached engine answer (tests, and after the person starts Docker). */
export function clearDockerReadyCache(): void {
  readyCache = undefined;
}
