// Finds mod jars in the selected files/folders and works out what each one is.
import { promises as fs } from 'fs';
import * as path from 'path';
import { readJarInfo } from './jar';
import { LOADERS, LOADER_PATTERN, compareVersions, loaderLabel } from './minecraft';

export { compareVersions, loaderLabel };

export const DEFAULT_PATTERN = `^(?<mod>.+?)-(?<loader>${LOADER_PATTERN})-(?<version>[^+]+)[+](?<mc>.+)[.]jar$`;

export interface ParsedName {
  mod: string;
  loader: string;
  version: string;
  mc: string;
}

export interface ModJar {
  path: string;
  /** Path relative to the common root, for display. */
  rel: string;
  filename: string;
  size: number;
  parsed?: ParsedName;
  /** True when the name did not match the pattern and the fields were guessed from the jar; loader and Minecraft version must be picked by hand. */
  guessed?: boolean;
  modName?: string;
  javaVersion?: number;
  problem?: string;
}

export function parseFilename(filename: string, pattern: string = DEFAULT_PATTERN): ParsedName | undefined {
  const m = new RegExp(pattern, 'i').exec(filename);
  const g = m?.groups;
  if (!g || !g.mod || !g.loader || !g.version || !g.mc) {
    return undefined;
  }
  return { mod: g.mod, loader: g.loader.toLowerCase(), version: g.version, mc: g.mc };
}

const SKIP_SUFFIXES = ['-sources.jar', '-dev.jar', '-dev-shadow.jar', '-javadoc.jar'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.gradle', 'build', 'out']);

async function collectJars(target: string, out: string[]): Promise<void> {
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    if (target.toLowerCase().endsWith('.jar')) {
      out.push(target);
    }
    return;
  }
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await collectJars(full, out);
      }
    } else if (entry.name.toLowerCase().endsWith('.jar') && !SKIP_SUFFIXES.some((s) => entry.name.endsWith(s))) {
      out.push(full);
    }
  }
}

function commonRoot(targets: string[]): string {
  const dirs = targets.map((t) => path.resolve(t));
  if (dirs.length === 1) {
    return dirs[0].toLowerCase().endsWith('.jar') ? path.dirname(dirs[0]) : dirs[0];
  }
  let root = path.dirname(dirs[0]);
  while (!dirs.every((d) => d === root || d.startsWith(root + path.sep))) {
    const up = path.dirname(root);
    if (up === root) {
      break;
    }
    root = up;
  }
  return root;
}

export async function scanTargets(
  targets: string[],
  pattern: string = DEFAULT_PATTERN,
): Promise<{ root: string; jars: ModJar[] }> {
  const files: string[] = [];
  for (const t of targets) {
    await collectJars(t, files);
  }
  const root = commonRoot(targets);
  const jars: ModJar[] = [];
  for (const file of [...new Set(files)]) {
    const filename = path.basename(file);
    const jar: ModJar = {
      path: file,
      rel: path.relative(root, file) || filename,
      filename,
      size: 0,
      parsed: parseFilename(filename, pattern),
    };
    try {
      const buf = await fs.readFile(file);
      jar.size = buf.length;
      const info = readJarInfo(buf);
      jar.modName = info.modName;
      jar.javaVersion = info.javaVersion;
      if (!jar.parsed) {
        // Not named <mod>-<loader>-<version>+<mc>.jar: take what the jar says and let the user pick the rest.
        jar.guessed = true;
        jar.parsed = {
          mod: info.modId ?? filename.replace(/[.]jar$/i, ''),
          loader: info.loader ?? '',
          version: '',
          mc: '',
        };
      }
    } catch (err) {
      jar.parsed = undefined;
      jar.problem = `Could not read jar: ${(err as Error).message}`;
    }
    jars.push(jar);
  }
  const loaderOrder = ['fabric', 'quilt', 'forge', 'neoforge', ...LOADERS.map((l) => l.id)];
  jars.sort((a, b) => {
    if (!a.parsed || !b.parsed) {
      return a.parsed ? -1 : b.parsed ? 1 : a.filename.localeCompare(b.filename);
    }
    return (
      a.parsed.mod.localeCompare(b.parsed.mod) ||
      loaderOrder.indexOf(a.parsed.loader) - loaderOrder.indexOf(b.parsed.loader) ||
      compareVersions(a.parsed.mc, b.parsed.mc)
    );
  });
  return { root, jars };
}

/** Fills in a display name template. `tags` are the loader / Minecraft / Java values picked in the form. */
export function renderDisplayName(
  template: string,
  jar: ModJar,
  name: string,
  tags?: { loader?: string; mc?: string; java?: number },
): string {
  const p = jar.parsed!;
  const loader = tags?.loader ?? p.loader;
  const java = tags?.java ?? jar.javaVersion;
  const values: Record<string, string> = {
    name,
    mod: p.mod,
    version: p.version,
    loader,
    Loader: loaderLabel(loader),
    mc: tags?.mc ?? p.mc,
    java: java ? String(java) : '',
    filename: jar.filename,
  };
  return template
    .replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key] : all))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "weaponry" -> "Weaponry", "letsmine-hud" -> "Letsmine Hud". Used when the jar has no name. */
export function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
