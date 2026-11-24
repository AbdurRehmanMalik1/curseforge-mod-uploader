# Changelog

## 0.2.0

First public release.

- Upload every jar in a release folder (and its subfolders) to CurseForge from one form.
- Loader, mod version and Minecraft version are read from the jar's file name, and Java version from its class files. Jars with other names get their loader from the jar's metadata.
- Per-file pickers for loader, Minecraft version, Java version, environment and display name, plus **Set on selected files** for bulk changes.
- One changelog for the whole upload, loaded from `CHANGELOG.md` in the release folder when there is one.
- **Check versions** shows the tags each file will get before anything is uploaded.
- Safety checks: unknown versions block the upload, already-uploaded jars are left unticked, and a rejected token or project ID stops the run at the first file.
- API token kept in VS Code's secret storage.
