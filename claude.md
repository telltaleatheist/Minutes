# BoardNotes

An Electron application for organizing RODECaster audio recordings and generating AI-powered meeting notes for Secular Student Alliance board meetings.

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

- Electron 28
- Whisper.cpp for transcription
- Ollama / Claude / OpenAI for AI generation
- Creamsicle theme (orange gradient)

## Project Structure

```
BoardNotes/
├── main.js          # Electron main process, IPC handlers
├── preload.js       # Context bridge for renderer
├── renderer.js      # UI logic and event handlers
├── index.html       # Main UI
├── styles.css       # Creamsicle theme styles
├── src/
│   └── audio-organizer.js  # RODECaster file scanning logic
└── utilities/
    ├── bin/         # Whisper binaries
    └── models/      # Whisper models (base)
```

## Development

```bash
npm install
npm start                    # Run the app
npm run electron:dev         # Run with logging
npm run electron:debug       # Run with DevTools
npm run package:win-x64      # Package for Windows
```

## Important Notes for AI Assistants

**DO NOT create files named `nul`, `con`, `prn`, `aux`, or `com1`-`com9`** - these are reserved device names on Windows and will cause issues. If you need a null output, use a different approach.
