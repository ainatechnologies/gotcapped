# Capped

**See what your AI subscription actually gives you.** Capped reads the usage logs your AI tools already write on your machine. It prices every request at API list prices and shows you the **API-equivalent dollars per full usage bar**, week by week.

- **Menu bar app** (macOS first; Windows and Linux to follow). Results appear right after the first history scan.
- **CLI:** `npx gotcapped`

Supports Claude Code and Codex. See [www.gotcapped.com](https://www.gotcapped.com) for the public board.

## Numbers only, never prompts
Only token counts, model names, cache hits and timestamps leave your machine. Prompts, outputs, file paths, session IDs and emails never do. A privacy allow-list test (`gotcapped-cli/test`, `gotcapped-tray/test`) fails the build if anything outside the allow-list reaches the upload payload. You can delete your data from the app or the CLI at any time.

## Repo layout
- `gotcapped-cli/`: the `gotcapped` npm package. It is the shared engine: parsers, pricing, attribution, payload and privacy rules.
- `gotcapped-tray/`: the Tauri menu bar app. It uses the same engine, so both parse and price identically.

## Develop
```sh
(cd gotcapped-cli && npm ci && npm test)
(cd gotcapped-tray && npm ci && npm test)
```
CI (`.github/workflows/ci.yml`) runs these on every PR and needs no secrets. Signed release builds (`release.yml`) run only on maintainer tags.

## License
MIT © AINA Technologies LLC · [ainatechnologies.llc](https://ainatechnologies.llc)
