# Boopi Desktop

Boopi Desktop is a small, transparent macOS companion built from zxlab's existing
Codex v2 pet atlas. It stays above ordinary windows, keeps its own position and
size, and exposes quiet controls from the menu bar.

## Local development

```bash
npm run check
npm test
npm run dev
```

## Build the macOS app

```bash
npm run build:desktop
```

The unsigned local application is written under
`src-tauri/target/release/bundle/macos/Boopi.app`.

## Controls

- Drag Boopi to move it. The position is restored on the next launch.
- Move the pointer over Boopi to use the sixteen look directions.
- Click Boopi for a short, finite action sequence.
- Use the menu bar icon to hide or show Boopi, enable quiet mode, change size,
  control launch at login, or quit.

No model provider key or zxlab server credential is bundled in the app.
