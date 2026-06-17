# Minutes

An Electron application that transcribes meeting audio/video and generates AI-powered meeting notes, running locally. (Originally "BoardNotes", built for Secular Student Alliance board meetings; now general-purpose.)

## Features

- **Audio Scanning**: Scans RODECaster directory for recording sessions, showing only master audio (Stereo Mix) files
- **Direct File Loading**: Load any audio file directly without scanning
- **Whisper Transcription**: Converts audio to text using local Whisper AI (CPU mode)
- **AI Meeting Notes**: Generates formatted meeting notes using:
  - Ollama (local) - cogito:32b recommended
  - Claude API (Anthropic)
  - OpenAI API
- **Email-Friendly Output**: Notes formatted with clear headers, bullet points, and proper spacing for easy copy-paste to email

## Tech Stack

- **Electron** (main process) + **Angular 21** (renderer) — TypeScript throughout
- Angular: standalone components, signals, zoneless change detection, no router (single screen + overlay)
- Whisper.cpp for transcription
- Local llama-server / Ollama / Claude / OpenAI for AI generation
- Creamsicle theme (orange gradient) — `src/styles.scss`

## Architecture

The app is split into two TypeScript builds (like the bookforge project it's modeled on):

- **`electron/`** — main process, compiled by `tsconfig.electron.json` → `dist/electron/`
  (CommonJS). Holds `main.ts`, `preload.ts`, IPC handlers, `audio-organizer.ts`,
  `llama-runtime.ts`, and the `components/` download system.
- **`src/`** — Angular renderer, built by the Angular CLI → `dist/renderer/browser/`.
  The renderer never touches the DOM or `window.electronAPI` directly: components are
  declarative templates driven by signals, and all IPC goes through
  `core/services/electron.service.ts`.

In dev, `main.ts` loads the Angular dev server (`http://localhost:4250`); when packaged
it loads `dist/renderer/browser/index.html` (`app.isPackaged`).

## Project Structure

```
Minutes/
├── electron/                  # Main process (CommonJS, tsconfig.electron.json)
│   ├── main.ts                # BrowserWindow + IPC handlers
│   ├── preload.ts             # contextBridge → window.electronAPI
│   ├── audio-organizer.ts
│   ├── llama-runtime.ts
│   └── components/            # Component download system (catalog, manager, …)
├── src/                       # Angular renderer
│   ├── main.ts                # bootstrapApplication(App)
│   ├── index.html
│   ├── styles.scss            # Creamsicle theme (ported from styles.css)
│   └── app/
│       ├── app.ts             # Shell: nav + studio + overlays
│       ├── core/
│       │   ├── models/        # types.ts, electron-api.ts
│       │   ├── services/      # electron, config, theme, toast, component, setup
│       │   └── utils/         # format.ts
│       ├── components/        # download-dock, toast-host
│       └── features/
│           ├── studio/        # home: drop → transcribe → generate → save
│           └── setup/         # first-run / config wizard
├── angular.json  tsconfig.json  tsconfig.app.json  tsconfig.electron.json
└── utilities/                 # bin/ (whisper binaries), models/ (bundled models)
```

## Development

```bash
npm install
npm start                    # build electron + ng serve + launch Electron (dev)
npm run electron:debug       # same, with DevTools
npm run build                # build electron + renderer (production)
npm run build:electron       # compile electron/ only
npm run start:web            # ng serve only (renderer in a browser)
npm run package:win          # build + electron-builder portable .exe
```

## Important Notes for AI Assistants

**DO NOT create files named `nul`, `con`, `prn`, `aux`, or `com1`-`com9`** - these are reserved device names on Windows and will cause issues. If you need a null output, use a different approach.
