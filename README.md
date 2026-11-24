# CurseForge Mod Uploader

A VS Code extension that uploads a whole release folder of Minecraft mod jars to CurseForge in one go.

If you build your mod for several loaders and Minecraft versions, you end up with a folder of jars that each need their own upload, tags and changelog on CurseForge's website. This extension does all of them from one form inside VS Code.

> Not affiliated with or endorsed by CurseForge or Overwolf. It uses CurseForge's public upload API with a token you create yourself.

## Requirements

- VS Code 1.90 or newer.
- A CurseForge account with at least one Minecraft mod project you can upload to.
- A CurseForge upload API token (see [Setup](#setup)).

## Install

- **From the Marketplace**: search for *CurseForge Mod Uploader* in the Extensions view and click **Install**.
- **From source**: see [Building from source](#building-from-source).

## What it fills in for you

Pick a folder of jars, for example `my-mod-1.2.0/` with `my-mod-fabric-1.2.0+1.20.1.jar`, `my-mod-forge-1.2.0+1.20.1.jar` and so on. The extension finds every jar in it, including jars in subfolders. For each jar it works out:

| Field | Where it comes from |
|---|---|
| Loader, mod version, Minecraft version | The file name, `<mod>-<loader>-<version>+<mc>.jar`. For other names, the loader is read from the jar's metadata and you pick the Minecraft version |
| Java version | The compiled class files inside the jar |
| Environment | You pick it: Client and/or Server, once for all files |
| Mod name | `fabric.mod.json` or `mods.toml` inside the jar. You can override it once and it is remembered |
| Display name | A template, by default `{mod}-{loader}-{version}+{mc}.jar`, giving e.g. `my-mod-fabric-1.2.0+1.20.1.jar`. The jar itself always uploads under its own file name |
| Dependencies | Per loader. None by default; only the ones you enter or configure are added |

You write one changelog, press **Upload**, confirm, and every file goes up with the right tags.

## Minecraft options

Every value worked out above is only a starting point. Each file row has its own pickers:

- **Mod loader**: NeoForge, Forge, Fabric, Quilt, Rift, Flint Loader or Risugami's ModLoader.
- **Minecraft**: type a version or pick one from CurseForge's list (loaded once a token is set).
- **Java**: a Java version, or None.
- **Environment**: Client and/or Server. Nothing is preselected. **Environment (all files)** at the top sets every file at once; a row's own boxes handle exceptions. CurseForge requires at least one.
- **Display name**: follows the template until you type your own.

**Set on selected files** changes the loader, Minecraft version, Java or environment of every ticked file at once.

**Release options** match the CurseForge form: publish automatically once approved, or hold the file so you can publish it yourself once approved.

The Minecraft-specific parts (loaders, environments, Java, version matching) live in `src/minecraft.ts`.

## Setup

1. Create an upload API token on CurseForge: account settings, then **API Tokens** (https://legacy.curseforge.com/account/api-tokens).
2. In VS Code run **CurseForge: Set API Token** and paste it. It is stored in VS Code's secret storage, never in settings files.
3. Find your project ID on the CurseForge project page, in the **About Project** box.

## Uploading a release

1. Right-click a release folder (or some jars) in the Explorer and choose **Upload Mods to CurseForge...**. You can also run the command from the Command Palette and pick a folder. The picker opens in your workspace's `releases/` folder if there is one.
2. Enter the project ID the first time. It is saved per mod in the `curseforgeUpload.projects` setting.
3. Write the changelog. A `CHANGELOG.md` in the release folder is loaded automatically. Otherwise your draft is kept per mod version while you type.
4. Press **Check versions**. It asks CurseForge for its version list and shows the tags each file will get. Any Minecraft version or loader CurseForge does not know is shown in red.
5. Press **Upload**. A confirmation lists what will be published. Files are uploaded one at a time, and each row shows its new CurseForge file ID.

Safety checks:

- Nothing is uploaded if any selected file has a version CurseForge does not recognise.
- Jars already uploaded from this machine are marked and left unticked. Re-uploading them asks you first. **CurseForge: Forget Upload History** clears this record.
- If the token or project ID is rejected, the run stops at the first file instead of failing every one.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `curseforgeUpload.projects` | `{}` | Project ID, name and dependencies per mod. Filled in for you |
| `curseforgeUpload.displayNameTemplate` | `{mod}-{loader}-{version}+{mc}.jar` | File display name. Placeholders: `{name} {mod} {version} {loader} {Loader} {mc} {java} {filename}`. For a readable title use e.g. `{name} {version} for {Loader} {mc}` |
| `curseforgeUpload.defaultReleaseType` | `release` | Preselected release type |
| `curseforgeUpload.defaultDependencies` | `{}` | Required dependency slugs per loader for new mods, e.g. `{"fabric": ["fabric-api"]}` |
| `curseforgeUpload.environments` | `[]` | Preselected on every file. Empty by default, so you pick them in the form. CurseForge requires at least one on every file |
| `curseforgeUpload.addJavaVersion` | `true` | Preselect the Java version read from the jar |
| `curseforgeUpload.filenamePattern` | see settings | Regular expression with `mod`, `loader`, `version` and `mc` groups |

## Building from source

You need Node.js 20 or newer.

```
git clone https://github.com/AbdurRehmanMalik1/curseforge-mod-uploader.git
cd curseforge-mod-uploader
npm install
npm test          # compiles and runs the tests
npm run package   # builds curseforge-mod-uploader-<version>.vsix
code --install-extension curseforge-mod-uploader-<version>.vsix
```

To try changes without installing, open the folder in VS Code, run `npm run watch`, and press **F5** to start an Extension Development Host.

A few tests read real mod jars from a `releases/` folder next to this one. They are skipped when that folder is missing, so `npm test` passes on a fresh clone.

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/AbdurRehmanMalik1/curseforge-mod-uploader/issues). The Minecraft-specific code is in `src/minecraft.ts`, the CurseForge API client in `src/curseforge.ts`, jar reading in `src/jar.ts` and `src/scan.ts`, and the upload form in `src/panel.ts` and `media/`.

## License

[MIT](LICENSE)
