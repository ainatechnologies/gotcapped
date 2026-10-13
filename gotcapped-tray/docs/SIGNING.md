# Signing & release: what Ali needs to add (once)

Nothing secret lives in this repo. CI reads five **GitHub Actions repository secrets**
(repo → Settings → Secrets and variables → Actions → *New repository secret*). Paste each value there directly;
never into chat, email, or a file in the repo.

| Secret | What it is | Where to get it |
|---|---|---|
| `APPLE_CERTIFICATE` | Your **Developer ID Application** certificate + private key as a `.p12`, **base64-encoded** | Keychain Access → My Certificates → right-click "Developer ID Application: AINA Technologies (TEAMID)" → Export → `.p12` with a password. Then `base64 -i cert.p12 \| pbcopy` and paste. (No certificate yet? developer.apple.com → Certificates → + → *Developer ID Application*; only the Account Holder can create it.) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` | You chose it in the step above |
| `APPLE_ID` | The Apple ID email of the developer account | Your account |
| `APPLE_PASSWORD` | An **app-specific password** (not your Apple ID password) | appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate "gotcapped-notary" |
| `APPLE_TEAM_ID` | 10-character Team ID | developer.apple.com → Membership details |

`GITHUB_TOKEN` is automatic. The signing identity name is read from the certificate at build time (no secret needed).

## What the pipeline does
- **macOS** (Apple silicon on `macos-14`, Intel on `macos-13`): imports the cert into a throwaway keychain, builds,
  signs app + engine sidecar with Developer ID and the **hardened runtime** (`bundle.macOS.hardenedRuntime`,
  `src-tauri/Entitlements.plist`: JIT only, needed by the Node-based engine), submits to Apple with **notarytool**
  (Tauri does this when `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` are set), staples, then verifies with
  `codesign --verify`, `spctl --assess` and `stapler validate`. Output: `.dmg` + `.app.tar.gz`.
- **Windows**: `.msi` + NSIS `.exe`, **unsigned in v0**. Users see SmartScreen "Windows protected your PC" →
  *More info* → *Run anyway*. Fix later with Azure Trusted Signing (~$9.99/mo, needs Ali's yes).
- **Linux**: `.AppImage` + `.deb`. No signing needed.
- Always a **draft, pre-release** GitHub release. Publishing is a manual click.

## How to cut a build
1. Put `gotcapped-cli/` and `gotcapped-tray/` in one private repo (layout the workflow expects).
2. Add the five secrets above.
3. Actions → *release* → *Run workflow* (or push a tag `tray-v0.1.0`).
4. Download the draft's `.dmg`, open it on a Mac that has never seen the app: it must open with no Gatekeeper warning.

## Local mac build (optional)
`APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)" APPLE_ID=… APPLE_PASSWORD=… APPLE_TEAM_ID=… npm run tauri build`
with the cert already in your login keychain. Use env vars in your own terminal, never commit them.
