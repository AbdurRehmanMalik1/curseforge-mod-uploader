// Client for the CurseForge upload API (the token-based "upload-file" API that Gradle plugins use).
import { promises as fs } from 'fs';
import * as path from 'path';

export interface GameVersionType {
  id: number;
  name: string;
  slug: string;
}

export interface GameVersion {
  id: number;
  gameVersionTypeID: number;
  name: string;
  slug: string;
}

export interface VersionCatalog {
  types: GameVersionType[];
  versions: GameVersion[];
}

export type ReleaseType = 'release' | 'beta' | 'alpha';

export interface UploadMetadata {
  changelog: string;
  changelogType: 'text' | 'html' | 'markdown';
  displayName?: string;
  gameVersions: number[];
  releaseType: ReleaseType;
  /** True: after approval the file waits for you to publish it on CurseForge. */
  isMarkedForManualRelease?: boolean;
  relations?: {
    projects: { slug: string; type: 'requiredDependency' | 'optionalDependency' | 'embeddedLibrary' | 'incompatible' | 'tool' }[];
  };
}

export class CurseForgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type FetchFn = typeof fetch;
type LogFn = (line: string) => void;

/** "fetch failed" hides the real reason (DNS, TLS, proxy, reset) in `cause`. */
function describe(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string; code?: string } };
  const cause = e.cause ? ` (${[e.cause.code, e.cause.message].filter(Boolean).join(': ')})` : '';
  return `${e.message ?? String(err)}${cause}`;
}

export class CurseForgeClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://minecraft.curseforge.com/api',
    private readonly fetchFn: FetchFn = fetch,
    private readonly log: LogFn = () => undefined,
  ) {}

  private async request(urlPath: string, init: RequestInit = {}): Promise<unknown> {
    const url = this.baseUrl.replace(/\/+$/, '') + urlPath;
    const method = init.method ?? 'GET';
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        headers: { 'X-Api-Token': this.token, ...(init.headers ?? {}) },
      });
    } catch (err) {
      this.log(`${method} ${url} -> could not connect: ${describe(err)}`);
      throw new CurseForgeError(`Could not reach CurseForge: ${describe(err)}`);
    }
    const text = await res.text();
    this.log(`${method} ${url} -> ${res.status} ${res.statusText}${res.ok && method === 'GET' ? '' : `: ${text.slice(0, 2000)}`}`);
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON error pages are reported by status below.
    }
    if (!res.ok) {
      const b = body as { errorMessage?: string; errorCode?: number } | undefined;
      let msg = `${res.status}: ${b?.errorMessage ?? (text.slice(0, 300) || res.statusText)}`;
      if (res.status === 401 || res.status === 403) {
        msg = `CurseForge rejected the API token (${res.status}). ${msg}`;
      }
      throw new CurseForgeError(msg, res.status);
    }
    return body;
  }

  async getCatalog(): Promise<VersionCatalog> {
    const [types, versions] = await Promise.all([
      this.request('/game/version-types') as Promise<GameVersionType[]>,
      this.request('/game/versions') as Promise<GameVersion[]>,
    ]);
    return { types, versions };
  }

  async uploadFile(projectId: number, filePath: string, metadata: UploadMetadata): Promise<number> {
    const data = await fs.readFile(filePath);
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append('file', new Blob([data], { type: 'application/java-archive' }), path.basename(filePath));
    const body = (await this.request(`/projects/${projectId}/upload-file`, { method: 'POST', body: form })) as
      | { id?: number }
      | undefined;
    if (!body || typeof body.id !== 'number') {
      throw new CurseForgeError('CurseForge accepted the upload but returned no file id');
    }
    return body.id;
  }
}
