// Everything specific to Minecraft mods on CurseForge: the mod loaders and environments
// CurseForge offers, the Java versions, and how to read them from a jar or from
// CurseForge's game version list.
import type { GameVersion, VersionCatalog } from './curseforge';

export interface Loader {
  /** Lower-case id used in jar names and settings. */
  id: string;
  /** Name CurseForge shows for this loader. */
  label: string;
}

/** The mod loaders CurseForge lets a Minecraft file be tagged with, in the order its form lists them. */
export const LOADERS: Loader[] = [
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'forge', label: 'Forge' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'quilt', label: 'Quilt' },
  { id: 'rift', label: 'Rift' },
  { id: 'flint', label: 'Flint Loader' },
  { id: 'risugami', label: "Risugami's ModLoader" },
];

/** Where a mod runs. CurseForge requires at least one on every Minecraft file. */
export const ENVIRONMENTS = ['Client', 'Server'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Java versions offered before CurseForge's own list has been loaded. */
export const FALLBACK_JAVA_VERSIONS = [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 11, 8];

/** Loader ids the default file name pattern recognises. */
export const LOADER_PATTERN = LOADERS.map((l) => l.id).join('|');

export function loaderLabel(id: string): string {
  return LOADERS.find((l) => l.id === id)?.label ?? id;
}

/** Compares names loosely: "Risugami's ModLoader" matches "risugamis-modloader". */
export function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Works out the loader from the metadata files a jar contains, for jars whose name does not say. */
export function detectLoader(entryNames: Iterable<string>): string | undefined {
  const names = new Set(entryNames);
  if (names.has('META-INF/neoforge.mods.toml')) {
    return 'neoforge';
  }
  if (names.has('quilt.mod.json')) {
    return 'quilt';
  }
  if (names.has('fabric.mod.json')) {
    return 'fabric';
  }
  if (names.has('riftmod.json')) {
    return 'rift';
  }
  if (names.has('META-INF/mods.toml') || names.has('mcmod.info')) {
    return 'forge';
  }
  return undefined;
}

/** Version order that understands 1.21.11 > 1.21.4 and 26.1 > 1.21. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    const c = !isNaN(nx) && !isNaN(ny) && x !== '' && y !== '' ? nx - ny : x.localeCompare(y);
    if (c !== 0) {
      return c;
    }
  }
  return 0;
}

function versionsOfType(catalog: VersionCatalog, typeSlug: (slug: string) => boolean): GameVersion[] {
  const typeIds = new Set(catalog.types.filter((t) => typeSlug(t.slug)).map((t) => t.id));
  return catalog.versions.filter((v) => typeIds.has(v.gameVersionTypeID));
}

/** Minecraft versions CurseForge knows, newest first. Snapshots are left out. */
export function minecraftVersions(catalog: VersionCatalog): string[] {
  const names = versionsOfType(catalog, (s) => s.startsWith('minecraft-'))
    .map((v) => v.name)
    .filter((n) => /^\d+(\.\d+)+$/.test(n));
  return [...new Set(names)].sort(compareVersions).reverse();
}

/** Java versions CurseForge knows, newest first. */
export function javaVersions(catalog: VersionCatalog): number[] {
  const nums = versionsOfType(catalog, (s) => s === 'java')
    .map((v) => Number(/(\d+)/.exec(v.name)?.[1]))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => b - a);
}

/** Finds a version by name among the given CurseForge version types. */
export function findVersion(
  catalog: VersionCatalog,
  typeSlug: (slug: string) => boolean,
  name: string,
): GameVersion | undefined {
  const wanted = normalize(name);
  return versionsOfType(catalog, typeSlug).find((v) => normalize(v.name) === wanted || normalize(v.slug) === wanted);
}

/** The game version tags of one file. */
export interface FileTags {
  loader: string;
  mc: string;
  java?: number;
  environments?: string[];
}

export interface Resolved {
  ids: number[];
  labels: string[];
  missing: string[];
}

/** Maps a file's loader, Minecraft version, Java version and environments onto CurseForge game version ids. */
export function resolveGameVersions(catalog: VersionCatalog, tags: FileTags): Resolved {
  const out: Resolved = { ids: [], labels: [], missing: [] };
  const add = (label: string, v: GameVersion | undefined) => {
    if (v) {
      out.ids.push(v.id);
      out.labels.push(v.name);
    } else {
      out.missing.push(label);
    }
  };

  if (!tags.mc) {
    out.missing.push('Minecraft version (not set)');
  } else {
    add(`Minecraft ${tags.mc}`, findVersion(catalog, (s) => s.startsWith('minecraft-'), tags.mc));
  }
  if (!tags.loader) {
    out.missing.push('mod loader (not set)');
  } else {
    add(`loader ${loaderLabel(tags.loader)}`, findVersion(catalog, (s) => s === 'modloader', loaderLabel(tags.loader)));
  }
  if (tags.java) {
    add(`Java ${tags.java}`, findVersion(catalog, (s) => s === 'java', `Java ${tags.java}`));
  }
  const envs = tags.environments ?? [];
  if (!envs.length) {
    out.missing.push('environment (tick Client and/or Server)');
  }
  for (const env of envs) {
    add(`environment ${env}`, findVersion(catalog, (s) => s === 'environment', env));
  }
  return out;
}
