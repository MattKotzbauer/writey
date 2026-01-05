# Writey 📝

Write on paper → Take a photo → Claude Code executes your instructions.

## How it works

```
┌─────────────────┐    WiFi/USB    ┌──────────────────┐
│  Android Phone  │ ──────────────▶│  Linux Machine   │
│  (Camera)       │     (ADB)      │                  │
└─────────────────┘                └────────┬─────────┘
                                            │
                                   ┌────────▼─────────┐
                                   │   Gemini OCR     │
                                   └────────┬─────────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │   Tmux Session            │
                              │ ┌───────────┬───────────┐ │
                              │ │           │ nvim      │ │
                              │ │  Claude   │ notes.md  │ │
                              │ │  Code     ├───────────┤ │
                              │ │           │ watcher   │ │
                              │ └───────────┴───────────┘ │
                              └───────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
bun install

# Connect phone via USB (first time) or wireless
bun start -w

# That's it! You're now in the tmux session.
```

## Usage

1. Run `bun start -w` (wireless) or `bun start` (USB)
2. Write instructions on paper
3. Take a photo with your phone
4. Watch Claude execute your instructions

## Layout

- **Left pane (65%)**: Interactive Claude Code session
- **Top-right**: `nvim notes.md` - see/edit transcribed notes
- **Bottom-right**: Photo watcher logs

## Requirements

- [Bun](https://bun.sh)
- [Claude Code](https://claude.com/claude-code) CLI
- Android phone with USB debugging enabled
- tmux, nvim

## Wireless Mode

First run requires USB to enable wireless ADB. After that, just use `-w`:

```bash
bun start -w
```

The phone's IP is saved for future sessions.

## Session Management

```bash
# Detach: Ctrl-b d
# Reattach
tmux -L paper-claude attach

# Kill everything
tmux -L paper-claude kill-server
```

## License

MIT
