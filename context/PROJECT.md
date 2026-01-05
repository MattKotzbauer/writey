# Paper Note → Claude Code Bridge

## Overview

This app allows you to write instructions on paper, photograph them with your Android phone, and have them automatically transcribed and executed by Claude Code.

## Architecture

```
┌─────────────────┐    USB/ADB     ┌──────────────────┐
│  Android Phone  │ ──────────────▶│  Linux Machine   │
│  (Camera)       │                │  (This script)   │
└─────────────────┘                └────────┬─────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │   Gemini API     │
                                   │   (OCR)          │
                                   └────────┬─────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │   Claude Code    │
                                   │   (Execution)    │
                                   └──────────────────┘
```

## Flow

1. **Photo Detection**: Script polls Android's DCIM/Camera folder via ADB every 2 seconds
2. **Pull**: New photos (after script start) are pulled to `./incoming_photos/`
3. **OCR**: Gemini 2.0 Flash transcribes the handwritten text
4. **Execute**: Transcribed text sent to Claude Code via `claude --print`
5. **Session Continuity**: Subsequent notes use `--continue` flag to maintain context

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Main script |
| `platform-tools/` | Local ADB installation (downloaded) |
| `incoming_photos/` | Where pulled photos are stored |
| `.processed_photos` | (Legacy) Tracking file |
| `context/` | Project documentation |

## Dependencies

- **Runtime**: Bun
- **Gemini API**: For OCR (`@google/generative-ai`)
- **ADB**: For phone communication (bundled in `platform-tools/`)
- **Claude Code**: For execution (uses your subscription)

## Configuration

```typescript
const GEMINI_API_KEY = "AIzaSyC7GdnlfOoHS5me82y-_vx9GmgeCW5Tqbk";
const DCIM_PATH = "/sdcard/DCIM/Camera";  // Android camera folder
const POLL_INTERVAL = 2000;               // 2 seconds
```

## Authentication & Billing

- **Gemini OCR**: Uses provided API key (billed to Google Cloud)
- **Claude Code**: Uses `claude --print` which bills to your Claude Code subscription (Max/Pro), NOT Anthropic API console

## Session Continuity

The script maintains context across notes using Claude Code's `--continue` flag:
- First note: `claude --print "your note"`
- Subsequent notes: `claude --print --continue "your note"`

This means Claude remembers what you asked in previous notes within the same script session.

## Usage

### USB Mode (default)
```bash
cd /home/matt/thing/note_app
bun start
```

### Wireless Mode
```bash
bun start --wireless
# or
bun start -w
```

**First-time wireless setup:**
1. Connect phone via USB once
2. Run `bun start --wireless`
3. Script will enable TCP/IP mode and save the IP
4. Disconnect USB - you're now wireless!

**Subsequent runs:**
Just run `bun start --wireless` - it uses the saved IP

Then:
1. Write on paper
2. Take photo with Android phone
3. Wait ~2-5 seconds for detection + processing
4. Claude executes the transcribed instructions

## Requirements

- Android phone with USB debugging enabled
- Phone authorized for USB debugging on this machine
- Bun runtime installed
- Claude Code CLI installed and authenticated

## Tested On

- Fedora 43
- Bun 1.3.5
- Android device: RFCW421R94K (Samsung)
- Claude Code 2.0.76

## Future Improvements

- [x] Wireless ADB support (no USB cable needed) ✅
- [ ] Better error handling for OCR failures
- [ ] Support for multiple image formats
- [ ] Web UI for viewing session history
