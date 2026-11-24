import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CurseForgeClient, ReleaseType, UploadMetadata, VersionCatalog } from './curseforge';
import { DEFAULT_PATTERN, ModJar, renderDisplayName, scanTargets, titleCase } from './scan';
import {
  ENVIRONMENTS,
  FALLBACK_JAVA_VERSIONS,
  LOADERS,
  compareVersions,
  javaVersions,
  minecraftVersions,
  resolveGameVersions,
} from './minecraft';
import { getToken } from './extension';
import { log, outputChannel } from './log';

const HISTORY_KEY = 'curseforgeUpload.history';
const CHANGELOG_KEY = 'curseforgeUpload.changelogDrafts';
const CHANGELOG_FILES = ['CHANGELOG.md', 'changelog.md', 'CHANGELOG.txt', 'changelog.txt'];

interface ProjectSettings {
  projectId?: number;
  name?: string;
  dependencies?: Record<string, string[]>;
}

/** filename -> upload record, per CurseForge project id. */
type History = Record<string, Record<string, { fileId: number; date: string }>>;

/** What the user picked for one file in the form. */
interface FileForm {
  loader: string;
  mc: string;
  java: number | null;
  environments: string[];
  /** Final display name; empty means "use the template". */
  displayName: string;
}

interface FormState {
  mods: Record<string, { projectId: string; name: string }>;
  releaseType: ReleaseType;
  manualRelease: boolean;
  files: Record<string, FileForm>;
  changelog: string;
  changelogType: 'markdown' | 'text' | 'html';
  template: string;
  deps: Record<string, string>;
  selected: string[];
}

function config() {
  return vscode.workspace.getConfiguration('curseforgeUpload');
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function splitSlugs(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class UploadPanel {
  private static current: UploadPanel | undefined;

  private jars: ModJar[] = [];
  private root = '';
  private catalog: VersionCatalog | undefined;
  private busy = false;

  static async show(ctx: vscode.ExtensionContext, targets: string[]): Promise<void> {
    if (UploadPanel.current) {
      UploadPanel.current.panel.reveal();
    } else {
      UploadPanel.current = new UploadPanel(ctx);
    }
    await UploadPanel.current.load(targets);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly ctx: vscode.ExtensionContext) {
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('curseforgeUpload', 'CurseForge Upload', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    this.panel.onDidDispose(() => (UploadPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg).catch((err) => this.fail(err)));
    this.panel.webview.html = this.html(media);
  }

  private html(media: vscode.Uri): string {
    const w = this.panel.webview;
    const n = nonce();
    const css = w.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>CurseForge Upload</title>
</head>
<body>
<div id="app"><p class="muted">Scanning jars...</p></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private fail(err: unknown): void {
    this.busy = false;
    const message = err instanceof Error ? err.message : String(err);
    this.post({ type: 'error', message });
  }

  private history(): History {
    return this.ctx.globalState.get<History>(HISTORY_KEY) ?? {};
  }

  private projects(): Record<string, ProjectSettings> {
    return config().get<Record<string, ProjectSettings>>('projects') ?? {};
  }

  private async load(targets: string[]): Promise<void> {
    const pattern = config().get<string>('filenamePattern') || DEFAULT_PATTERN;
    const { root, jars } = await scanTargets(targets, pattern);
    this.root = root;
    this.jars = jars;

    const projects = this.projects();
    const history = this.history();
    const defaultDeps = config().get<Record<string, string[]>>('defaultDependencies') ?? {};
    const drafts = this.ctx.globalState.get<Record<string, string>>(CHANGELOG_KEY) ?? {};

    const modIds = [...new Set(jars.filter((j) => j.parsed).map((j) => j.parsed!.mod))];
    const mods: Record<string, { projectId: string; name: string; versions: string[] }> = {};
    for (const mod of modIds) {
      const p = projects[mod] ?? {};
      const fromJar = jars.find((j) => j.parsed?.mod === mod && j.modName)?.modName;
      mods[mod] = {
        projectId: p.projectId ? String(p.projectId) : '',
        name: p.name ?? fromJar ?? titleCase(mod),
        versions: [...new Set(jars.filter((j) => j.parsed?.mod === mod).map((j) => j.parsed!.version))],
      };
    }

    // Dependencies: saved ones for the (first) mod, else the configured defaults.
    const savedDeps = modIds.length ? projects[modIds[0]]?.dependencies : undefined;
    const deps: Record<string, string> = {};
    for (const { id } of LOADERS) {
      deps[id] = (savedDeps?.[id] ?? defaultDeps[id] ?? []).join(', ');
    }

    // Changelog: a changelog file in the folder wins, then the last draft for this mod.
    let changelog = '';
    for (const name of CHANGELOG_FILES) {
      try {
        changelog = (await fs.readFile(path.join(root, name), 'utf8')).trim();
        break;
      } catch {
        // not there
      }
    }
    if (!changelog && modIds.length === 1) {
      const v = mods[modIds[0]].versions[0];
      changelog = drafts[`${modIds[0]}@${v}`] ?? '';
    }

    // Nothing is preselected unless the setting says so; the user picks Client / Server in the form.
    const defaultEnvs = config().get<string[]>('environments') ?? [];
    const addJava = config().get<boolean>('addJavaVersion') ?? true;
    const mcFromJars = [...new Set(jars.map((j) => j.parsed?.mc).filter((v): v is string => !!v))]
      .sort(compareVersions)
      .reverse();

    this.post({
      type: 'init',
      root,
      loaders: LOADERS,
      environmentNames: ENVIRONMENTS,
      javaVersions: this.catalog ? javaVersions(this.catalog) : FALLBACK_JAVA_VERSIONS,
      mcVersions: this.catalog ? minecraftVersions(this.catalog) : mcFromJars,
      jars: jars.map((j) => {
        const pid = j.parsed ? projects[j.parsed.mod]?.projectId : undefined;
        const prev = pid ? history[String(pid)]?.[j.filename] : undefined;
        return {
          path: j.path,
          rel: j.rel,
          filename: j.filename,
          size: j.size,
          parsed: j.parsed,
          guessed: j.guessed,
          javaVersion: j.javaVersion,
          problem: j.problem,
          uploaded: prev,
          // Starting values for the per-file pickers.
          meta: j.parsed
            ? {
                loader: j.parsed.loader,
                mc: j.parsed.mc,
                java: addJava && j.javaVersion ? j.javaVersion : null,
                environments: [...defaultEnvs],
              }
            : undefined,
        };
      }),
      mods,
      deps,
      changelog,
      changelogType: 'markdown',
      releaseType: config().get<string>('defaultReleaseType') ?? 'release',
      template: config().get<string>('displayNameTemplate') ?? '{mod}-{loader}-{version}+{mc}.jar',
      manualRelease: false,
      hasToken: Boolean(await getToken(this.ctx, false)),
    });

    // Fill the Minecraft / Java version lists from CurseForge in the background.
    if (!this.catalog) {
      void this.loadCatalogQuietly();
    }
  }

  private async loadCatalogQuietly(): Promise<void> {
    const token = await getToken(this.ctx, false);
    if (!token) {
      return;
    }
    try {
      this.catalog = await new CurseForgeClient(token, config().get<string>('apiBaseUrl'), fetch, log).getCatalog();
      this.postCatalog();
    } catch {
      // The lists fall back to what the jars say; Check versions reports any real problem.
    }
  }

  private postCatalog(): void {
    if (this.catalog) {
      this.post({ type: 'catalog', mcVersions: minecraftVersions(this.catalog), javaVersions: javaVersions(this.catalog) });
    }
  }

  private async client(): Promise<CurseForgeClient | undefined> {
    const token = await getToken(this.ctx, true);
    if (!token) {
      return undefined;
    }
    this.post({ type: 'token', hasToken: true });
    return new CurseForgeClient(token, config().get<string>('apiBaseUrl'), fetch, log);
  }

  /** Validates the form and resolves every selected jar against CurseForge's version list. */
  private async preflight(form: FormState) {
    const selected = this.jars.filter((j) => form.selected.includes(j.path) && j.parsed && !j.problem);
    if (!selected.length) {
      throw new Error('Select at least one jar.');
    }
    for (const jar of selected) {
      const f = form.files[jar.path];
      if (!f?.loader || !f.mc.trim()) {
        throw new Error(`Pick the mod loader and Minecraft version for ${jar.filename}.`);
      }
      if (!f.environments.length) {
        throw new Error(`Tick Client and/or Server for ${jar.filename}. CurseForge requires an environment on every file.`);
      }
    }
    for (const mod of new Set(selected.map((j) => j.parsed!.mod))) {
      const id = Number(form.mods[mod]?.projectId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Enter the CurseForge project ID for "${mod}". It is shown on the project page under "About Project".`);
      }
    }
    const client = await this.client();
    if (!client) {
      return undefined;
    }
    if (!this.catalog) {
      this.post({ type: 'status', message: 'Loading CurseForge game versions...' });
      this.catalog = await client.getCatalog();
      this.postCatalog();
    }
    const plan = selected.map((jar) => {
      const p = jar.parsed!;
      const f = form.files[jar.path];
      const tags = { loader: f.loader, mc: f.mc.trim(), java: f.java ?? undefined, environments: f.environments };
      const resolved = resolveGameVersions(this.catalog!, tags);
      const name = form.mods[p.mod]?.name?.trim() || titleCase(p.mod);
      return {
        jar,
        loader: f.loader,
        environments: f.environments,
        projectId: Number(form.mods[p.mod].projectId),
        displayName: f.displayName.trim() || renderDisplayName(form.template, jar, name, tags),
        resolved,
      };
    });
    this.post({
      type: 'checked',
      rows: plan.map((r) => ({
        path: r.jar.path,
        displayName: r.displayName,
        tags: r.resolved.labels,
        missing: r.resolved.missing,
      })),
    });
    return { client, plan };
  }

  private async saveSettings(form: FormState, plan: { jar: ModJar }[]): Promise<void> {
    const projects = { ...this.projects() };
    const deps: Record<string, string[]> = {};
    for (const { id } of LOADERS) {
      const slugs = splitSlugs(form.deps[id] ?? '');
      if (slugs.length) {
        deps[id] = slugs;
      }
    }
    for (const mod of new Set(plan.map((r) => r.jar.parsed!.mod))) {
      projects[mod] = {
        ...projects[mod],
        projectId: Number(form.mods[mod].projectId),
        name: form.mods[mod].name.trim() || undefined,
        dependencies: deps,
      };
    }
    await config().update('projects', projects, vscode.ConfigurationTarget.Global);
  }

  private async onMessage(msg: { type: string; form?: FormState; path?: string }): Promise<void> {
    switch (msg.type) {
      case 'rescan':
        await this.load([this.root]);
        return;
      case 'setToken':
        await vscode.commands.executeCommand('curseforgeUpload.setToken');
        this.post({ type: 'token', hasToken: Boolean(await getToken(this.ctx, false)) });
        return;
      case 'showLog':
        outputChannel().show(true);
        return;
      case 'reveal':
        if (msg.path) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
        }
        return;
      case 'draft': {
        const form = msg.form!;
        const first = this.jars.find((j) => j.parsed && form.selected.includes(j.path))?.parsed;
        if (first) {
          const drafts = { ...(this.ctx.globalState.get<Record<string, string>>(CHANGELOG_KEY) ?? {}) };
          drafts[`${first.mod}@${first.version}`] = form.changelog;
          await this.ctx.globalState.update(CHANGELOG_KEY, drafts);
        }
        return;
      }
      case 'check':
        if (this.busy) {
          return;
        }
        this.busy = true;
        try {
          const result = await this.preflight(msg.form!);
          if (result) {
            const bad = result.plan.filter((r) => r.resolved.missing.length).length;
            this.post({
              type: 'status',
              message: bad
                ? `${bad} file(s) have game versions CurseForge does not know. See the rows marked in red.`
                : `All ${result.plan.length} file(s) are ready to upload.`,
              level: bad ? 'error' : 'ok',
            });
          }
        } finally {
          this.busy = false;
        }
        return;
      case 'upload':
        if (this.busy) {
          return;
        }
        this.busy = true;
        try {
          await this.upload(msg.form!);
        } finally {
          this.busy = false;
          this.post({ type: 'idle' });
        }
        return;
    }
  }

  private async upload(form: FormState): Promise<void> {
    const result = await this.preflight(form);
    if (!result) {
      return;
    }
    const { client, plan } = result;
    const bad = plan.filter((r) => r.resolved.missing.length);
    if (bad.length) {
      this.post({
        type: 'status',
        level: 'error',
        message: `Nothing was uploaded. ${bad.length} file(s) have game versions CurseForge does not know: ${[
          ...new Set(bad.flatMap((r) => r.resolved.missing)),
        ].join(', ')}.`,
      });
      return;
    }
    if (!form.changelog.trim()) {
      throw new Error('Write a changelog first. CurseForge requires one for every file.');
    }

    const history = this.history();
    const repeats = plan.filter((r) => history[String(r.projectId)]?.[r.jar.filename]);
    const mods = [...new Set(plan.map((r) => r.jar.parsed!.mod))];
    const summary = mods
      .map((m) => `${form.mods[m].name || m} (project ${form.mods[m].projectId})`)
      .join(', ');
    const detail =
      `This publishes ${plan.length} file(s) to ${summary} as "${form.releaseType}"` +
      (form.manualRelease ? ', held for you to publish by hand once approved' : ', published automatically once approved') +
      '. Published files cannot be replaced, only deleted.' +
      (repeats.length ? `\n\n${repeats.length} of them were uploaded before from this machine: ${repeats.map((r) => r.jar.filename).join(', ')}.` : '');
    const go = await vscode.window.showWarningMessage(`Upload ${plan.length} file(s) to CurseForge?`, { modal: true, detail }, 'Upload');
    if (go !== 'Upload') {
      this.post({ type: 'status', message: 'Upload cancelled.' });
      return;
    }

    await this.saveSettings(form, plan);
    this.post({ type: 'uploading', paths: plan.map((r) => r.jar.path) });

    const relationsFor = (loader: string): UploadMetadata['relations'] => {
      const slugs = splitSlugs(form.deps[loader] ?? '');
      return slugs.length ? { projects: slugs.map((slug) => ({ slug, type: 'requiredDependency' as const })) } : undefined;
    };

    log(`Uploading ${plan.length} file(s) as ${form.releaseType}${form.manualRelease ? ', manual release' : ''}.`);
    let ok = 0;
    const failures: string[] = [];
    for (const row of plan) {
      this.post({ type: 'progress', path: row.jar.path, state: 'uploading' });
      try {
        const metadata: UploadMetadata = {
          changelog: form.changelog,
          changelogType: form.changelogType,
          displayName: row.displayName,
          gameVersions: row.resolved.ids,
          releaseType: form.releaseType,
          isMarkedForManualRelease: form.manualRelease || undefined,
          relations: relationsFor(row.loader),
        };
        log(`${row.jar.filename} -> project ${row.projectId}, tags ${row.resolved.labels.join(', ')}`);
        log(`  metadata: ${JSON.stringify({ ...metadata, changelog: `(${metadata.changelog.length} characters)` })}`);
        const fileId = await client.uploadFile(row.projectId, row.jar.path, metadata);
        log(`  uploaded, file id ${fileId}`);
        const h = this.history();
        h[String(row.projectId)] = { ...(h[String(row.projectId)] ?? {}), [row.jar.filename]: { fileId, date: new Date().toISOString() } };
        await this.ctx.globalState.update(HISTORY_KEY, h);
        ok++;
        this.post({ type: 'progress', path: row.jar.path, state: 'done', fileId });
      } catch (err) {
        const message = (err as Error).message;
        failures.push(`${row.jar.filename}: ${message}`);
        log(`  FAILED: ${message}`);
        this.post({ type: 'progress', path: row.jar.path, state: 'failed', message });
        // A bad token or missing project fails every file the same way; stop instead of repeating it.
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) {
          break;
        }
      }
    }

    const message = failures.length
      ? `Uploaded ${ok} of ${plan.length} file(s). ${failures.length} failed. Failed rows stay selected, so you can fix the problem and press Upload again.`
      : `Uploaded all ${ok} file(s). CurseForge reviews new files before they go public.`;
    this.post({ type: 'status', message, level: failures.length ? 'error' : 'ok' });
    log(message);
    if (failures.length) {
      outputChannel().show(true);
      vscode.window.showErrorMessage(`CurseForge upload: ${failures.length} file(s) failed. First error: ${failures[0]}`);
    } else {
      vscode.window.showInformationMessage(`CurseForge: uploaded ${ok} file(s).`);
    }
  }
}
