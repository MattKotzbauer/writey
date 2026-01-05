# Paper Note → Claude Code Bridge

## Overview

Write instructions on paper, photograph them with your Android phone, and have them automatically transcribed and sent to an interactive Claude Code session.

## Architecture

```
┌─────────────────┐    USB/WiFi     ┌──────────────────┐
│  Android Phone  │ ──────────────▶│  Linux Machine   │
│  (Camera)       │    (ADB)       │  (This script)   │
└─────────────────┘                └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │   Gemini API     │
                                  │   (OCR)          │
                                  └────────┬─────────┘
                                           │
                                           ▼
                              ┌────────────────────────────┐
                              │   Tmux Session             │
                              │  ┌──────────┬───────────┐  │
                              │  │ Claude   │ Notes     │  │
                              │  │ Code     │ Viewer    │  │
                              │  │ (65%)    │ (35%)     │  │
                              │  └──────────┴───────────┘  │
                              └────────────────────────────┘
```

## Flow

1. **Photo Detection**: Script polls Android's DCIM/Camera folder via ADB every 2 seconds
2. **Pull**: New photos (after script start) are pulled to `./incoming_photos/`
3. **OCR**: Gemini 2.0 Flash transcribes the handwritten text
4. **Append**: Transcribed text is appended to `notes.md`
5. **Notify**: A notification is sent to Claude Code in the tmux session
6. **Execute**: You can interact with Claude directly in the tmux session

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Main script - watcher process |
| `notes.md` | Auto-generated file with transcribed notes |
| `platform-tools/` | Local ADB installation |
| `incoming_photos/` | Where pulled photos are stored |
| `.wireless_adb` | Saved wireless IP config |
| `context/` | Project documentation |

## Tmux Session

The script creates a tmux session called `paper-claude` with two panes:

- **Left pane (65%)**: Interactive Claude Code session
- **Right pane (35%)**: `tail -f notes.md` showing live notes

You can:
- Attach to the session: `tmux attach -t paper-claude`
- Type directly to Claude Code
- See notes appear in real-time
- Switch between panes with `Ctrl-b + arrow keys`

## Usage

### USB Mode
```bash
bun start
```

### Wireless Mode (no USB needed)
```bash
bun start --wireless
# or
bun start -w
```

**First-time wireless setup:**
1. Connect phone via USB
2. Run `bun start --wireless`
3. Script enables TCP/IP mode and saves the IP
4. Disconnect USB - you're wireless!

**Subsequent runs:**
Just run `bun start --wireless` - uses saved IP

### Workflow

1. Start the script: `bun start --wireless`
2. Attach to tmux: `tmux attach -t paper-claude`
3. Write on paper
4. Take photo with your phone
5. Watch the note appear in the right pane
6. Claude Code receives a notification in the left pane
7. Interact with Claude directly if needed

### Managing the Session

```bash
# Attach to session
tmux attach -t paper-claude

# Detach (keep running): Ctrl-b, d

# Kill session
tmux kill-session -t paper-claude

# List sessions
tmux list-sessions
```

## Configuration

```typescript
const GEMINI_API_KEY = "...";          // Gemini API for OCR
const DCIM_PATH = "/sdcard/DCIM/Camera"; // Android camera folder
const POLL_INTERVAL = 2000;              // 2 seconds
const ADB_PORT = 5555;                   // Wireless ADB port
```

## Dependencies

- **Runtime**: Bun
- **Gemini API**: For OCR (`@google/generative-ai`)
- **ADB**: For phone communication (bundled in `platform-tools/`)
- **Claude Code**: Interactive CLI (your subscription)
- **tmux**: Terminal multiplexer

## Requirements

- Android phone with USB debugging enabled
- Phone authorized for USB debugging on this machine
- Bun runtime installed
- Claude Code CLI installed and authenticated
- tmux installed

## How Notes Work

When a new photo is detected:

1. OCR transcription is appended to `notes.md`:
   ```markdown
   ## Note #1 (1:30:45 PM)
   **Source:** 20260105_133045.jpg

   ```
   Your handwritten text here
   ```

   ---
   ```

2. Claude Code receives: `[New handwritten note #1 added to notes.md - please read and execute the instructions]`

3. Claude can then read `notes.md` to see your instructions

## Tested On

- Fedora 43
- Bun 1.3.5
- Android device: RFCW421R94K (Samsung)
- Claude Code 2.0.76
- tmux 3.4
