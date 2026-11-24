import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import * as os from 'os';
import { compareVersions, parseFilename, renderDisplayName, scanTargets } from '../scan';
import { CurseForgeClient, VersionCatalog } from '../curseforge';
import { LOADERS, detectLoader, javaVersions, minecraftVersions, resolveGameVersions } from '../minecraft';

const RELEASES = path.resolve(__dirname, '../../../releases');

test('parses release jar names', () => {
  assert.deepEqual(parseFilename('weaponry-fabric-2.5.0+1.20.1.jar'), { mod: 'weaponry', loader: 'fabric', version: '2.5.0', mc: '1.20.1' });
  assert.deepEqual(parseFilename('letsmine-vanilla-hud-neoforge-1.0.0+26.1.2.jar'), {
    mod: 'letsmine-vanilla-hud',
    loader: 'neoforge',
    version: '1.0.0',
    mc: '26.1.2',
  });
  assert.equal(parseFilename('letsmine-hud-forge-2.0.0+1.16.5.jar')?.loader, 'forge');
  assert.equal(parseFilename('random.jar'), undefined);
});

test('orders Minecraft versions numerically', () => {
  const v = ['26.1.2', '1.21.11', '1.16.5', '1.21.4', '26.3'].sort(compareVersions);
  assert.deepEqual(v, ['1.16.5', '1.21.4', '1.21.11', '26.1.2', '26.3']);
});

test('scans a real release folder, including subfolders', { skip: !existsSync(path.join(RELEASES, 'letsmine-hud-2.0.0')) }, async () => {
  const { jars } = await scanTargets([path.join(RELEASES, 'letsmine-hud-2.0.0')]);
  assert.equal(jars.length, 20);
  assert.ok(jars.every((j) => j.parsed && !j.problem), jars.find((j) => j.problem)?.problem);
  assert.ok(jars.some((j) => j.rel.startsWith('fabric')));
  // Java version comes from the class files and must match the table in docs/weaponry/listing.md.
  const java = Object.fromEntries(jars.map((j) => [j.parsed!.mc, j.javaVersion]));
  assert.equal(java['1.16.5'], 8);
  assert.equal(java['1.20.1'], 17);
  assert.equal(java['1.21.11'], 21);
  assert.equal(java['26.3'], 25);
  assert.ok(jars.every((j) => j.modName), 'mod name read from jar metadata');
});

test('reads mod names from Forge and Fabric metadata', { skip: !existsSync(path.join(RELEASES, 'weaponry-2.5.0')) }, async () => {
  const { jars } = await scanTargets([path.join(RELEASES, 'weaponry-2.5.0')]);
  const names = new Set(jars.map((j) => j.modName));
  console.log('weaponry names:', [...names]);
  assert.equal(names.size, 1, 'all loaders report the same name');
  const fabric = jars.find((j) => j.parsed?.loader === 'fabric' && j.parsed.mc === '1.21.1')!;
  assert.equal(renderDisplayName('{name} {version} for {Loader} {mc}', fabric, 'Weaponry Extended'), 'Weaponry Extended 2.5.0 for Fabric 1.21.1');
  const template = '{mod}-{loader}-{version}+{mc}.jar';
  assert.equal(renderDisplayName(template, fabric, 'Weaponry'), fabric.filename, 'default template reproduces the release jar name');
  assert.equal(renderDisplayName(template, fabric, 'Weaponry', { loader: 'quilt', mc: '1.21.4' }), 'weaponry-quilt-2.5.0+1.21.4.jar', 'follows the picked loader and version');
});

test('flags jars whose names do not match', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cfu-'));
  writeFileSync(path.join(dir, 'oddname.jar'), 'not a zip');
  const { jars } = await scanTargets([dir]);
  assert.equal(jars.length, 1);
  assert.ok(jars[0].problem);
});

const catalog: VersionCatalog = {
  types: [
    { id: 1, name: 'Minecraft 1.20', slug: 'minecraft-1-20' },
    { id: 2, name: 'Minecraft 26.3', slug: 'minecraft-26-3' },
    { id: 3, name: 'Modloader', slug: 'modloader' },
    { id: 4, name: 'Java', slug: 'java' },
    { id: 5, name: 'Environment', slug: 'environment' },
    { id: 6, name: 'Bukkit 1.20', slug: 'bukkit-1-20' },
  ],
  versions: [
    { id: 100, gameVersionTypeID: 6, name: '1.20.1', slug: '1-20-1' },
    { id: 101, gameVersionTypeID: 1, name: '1.20.1', slug: '1-20-1' },
    { id: 102, gameVersionTypeID: 2, name: '26.3', slug: '26-3' },
    { id: 200, gameVersionTypeID: 3, name: 'Fabric', slug: 'fabric' },
    { id: 201, gameVersionTypeID: 3, name: 'NeoForge', slug: 'neoforge' },
    { id: 300, gameVersionTypeID: 4, name: 'Java 17', slug: 'java-17' },
    { id: 400, gameVersionTypeID: 5, name: 'Client', slug: 'client' },
    { id: 401, gameVersionTypeID: 5, name: 'Server', slug: 'server' },
    { id: 202, gameVersionTypeID: 3, name: "Risugami's ModLoader", slug: 'risugamis-modloader' },
    { id: 203, gameVersionTypeID: 3, name: 'Flint Loader', slug: 'flint-loader' },
    { id: 103, gameVersionTypeID: 1, name: '1.20-Snapshot', slug: '1-20-snapshot' },
  ],
};

test('maps names to CurseForge game version ids', () => {
  const r = resolveGameVersions(catalog, { loader: 'fabric', mc: '1.20.1', java: 17, environments: ['Client'] });
  assert.deepEqual(r.ids, [101, 200, 300, 400]);
  assert.deepEqual(r.missing, []);
  const r2 = resolveGameVersions(catalog, { loader: 'neoforge', mc: '26.3', java: 25, environments: ['Server'] });
  assert.deepEqual(r2.ids, [102, 201, 401]);
  assert.deepEqual(r2.missing, ['Java 25'], 'a picked Java version CurseForge lacks is reported');
  const r3 = resolveGameVersions(catalog, { loader: 'forge', mc: '1.99', environments: ['Client'] });
  assert.deepEqual(r3.missing, ['Minecraft 1.99', 'loader Forge']);
  // CurseForge error 1021: every file needs an environment.
  assert.deepEqual(resolveGameVersions(catalog, { loader: 'fabric', mc: '1.20.1' }).missing, ['environment (tick Client and/or Server)']);
});

test('sends the upload as multipart with token header', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cfu-'));
  const file = path.join(dir, 'm-fabric-1.0.0+1.20.1.jar');
  writeFileSync(file, 'JARBYTES');
  let seen: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new CurseForgeClient('tok', 'https://example.test/api/', fakeFetch);
  const id = await client.uploadFile(123, file, {
    changelog: 'x',
    changelogType: 'markdown',
    displayName: 'M 1.0.0',
    gameVersions: [1, 2],
    releaseType: 'release',
    relations: { projects: [{ slug: 'fabric-api', type: 'requiredDependency' }] },
  });
  assert.equal(id, 4242);
  assert.equal(seen!.url, 'https://example.test/api/projects/123/upload-file');
  assert.equal((seen!.init.headers as Record<string, string>)['X-Api-Token'], 'tok');
  const form = seen!.init.body as FormData;
  assert.equal(JSON.parse(form.get('metadata') as string).relations.projects[0].slug, 'fabric-api');
  const blob = form.get('file') as File;
  assert.equal(blob.name, 'm-fabric-1.0.0+1.20.1.jar');
  assert.equal(await blob.text(), 'JARBYTES');
});

test('reports CurseForge error messages', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ errorCode: 1009, errorMessage: 'Invalid game version ID' }), { status: 400 })) as unknown as typeof fetch;
  const client = new CurseForgeClient('tok', 'https://example.test/api', fakeFetch);
  await assert.rejects(client.getCatalog(), /Invalid game version ID/);
});

test('knows every CurseForge Minecraft loader and both environments', () => {
  assert.deepEqual(
    LOADERS.map((l) => l.label),
    ['NeoForge', 'Forge', 'Fabric', 'Quilt', 'Rift', 'Flint Loader', "Risugami's ModLoader"],
  );
  const r = resolveGameVersions(catalog, { loader: 'risugami', mc: '1.20.1', environments: ['Client', 'Server'] });
  assert.deepEqual(r.ids, [101, 202, 400, 401]);
  assert.deepEqual(resolveGameVersions(catalog, { loader: 'flint', mc: '1.20.1', environments: ['Client'] }).ids, [101, 203, 400]);
  assert.deepEqual(resolveGameVersions(catalog, { loader: '', mc: '', environments: ['Client'] }).missing, ['Minecraft version (not set)', 'mod loader (not set)']);
});

test('lists Minecraft and Java versions from the catalog', () => {
  assert.deepEqual(minecraftVersions(catalog), ['26.3', '1.20.1']);
  assert.deepEqual(javaVersions(catalog), [17]);
});

test('detects the loader from jar metadata', () => {
  assert.equal(detectLoader(['META-INF/neoforge.mods.toml', 'META-INF/MANIFEST.MF']), 'neoforge');
  assert.equal(detectLoader(['META-INF/mods.toml']), 'forge');
  assert.equal(detectLoader(['fabric.mod.json']), 'fabric');
  assert.equal(detectLoader(['quilt.mod.json', 'fabric.mod.json']), 'quilt');
  assert.equal(detectLoader(['a.class']), undefined);
});

test('loads jars with other names, guessing what it can from the jar', { skip: !existsSync(path.join(RELEASES, 'skin-mixer-0.5.0')) }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cfu-'));
  copyFileSync(path.join(RELEASES, 'skin-mixer-0.5.0', 'skin-mixer-neoforge-0.5.0+26.3.jar'), path.join(dir, 'skinmixer-26.3-0.5.0.jar'));
  const { jars } = await scanTargets([dir]);
  assert.equal(jars[0].problem, undefined);
  assert.equal(jars[0].guessed, true);
  assert.equal(jars[0].parsed?.loader, 'neoforge');
  assert.equal(jars[0].parsed?.mc, '', 'Minecraft version is left for the user to pick');
});

test('sends the manual release flag', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cfu-'));
  const file = path.join(dir, 'm.jar');
  writeFileSync(file, 'x');
  let meta: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    meta = JSON.parse((init.body as FormData).get('metadata') as string);
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  await new CurseForgeClient('tok', 'https://example.test/api', fakeFetch).uploadFile(1, file, {
    changelog: 'x',
    changelogType: 'markdown',
    gameVersions: [1],
    releaseType: 'beta',
    isMarkedForManualRelease: true,
  });
  assert.equal(meta.isMarkedForManualRelease, true);
});
