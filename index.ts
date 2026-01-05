#!/usr/bin/env bun
import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, basename } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = "AIzaSyC7GdnlfOoHS5me82y-_vx9GmgeCW5Tqbk";

const ADB_PATH = join(import.meta.dir, "platform-tools", "adb");
const DCIM_PATH = "/sdcard/DCIM/Camera";
const LOCAL_PHOTOS_DIR = join(import.meta.dir, "incoming_photos");
const POLL_INTERVAL = 2000;
const WIRELESS_CONFIG_PATH = join(import.meta.dir, ".wireless_adb");
const ADB_PORT = 5555;

// Tmux config
const TMUX_SOCKET = "paper-claude"; // Custom socket for isolation
const TMUX_SESSION = "main";
const NOTES_FILE = join(import.meta.dir, "notes.md");

// Track which pane Claude is in
let claudePane = "";

const SCRIPT_START_TIME = Date.now();

if (!existsSync(LOCAL_PHOTOS_DIR)) {
  mkdirSync(LOCAL_PHOTOS_DIR, { recursive: true });
}

const processedThisSession = new Set<string>();
let targetDevice: string | null = null;
let noteCounter = 0;

// ============== ADB Helpers ==============

function adb(...args: string[]): string {
  try {
    const deviceArg = targetDevice ? `-s ${targetDevice}` : "";
    return execSync(`${ADB_PATH} ${deviceArg} ${args.join(" ")}`, { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function adbRaw(...args: string[]): string {
  try {
    return execSync(`${ADB_PATH} ${args.join(" ")}`, { encoding: "utf-8" });
  } catch {
    return "";
  }
}

// ============== Wireless ADB ==============

function getDeviceIp(): string | null {
  try {
    const output = adb("shell", "ip", "addr", "show", "wlan0");
    const match = output.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function saveWirelessConfig(ip: string): void {
  writeFileSync(WIRELESS_CONFIG_PATH, ip);
}

function loadWirelessConfig(): string | null {
  if (existsSync(WIRELESS_CONFIG_PATH)) {
    return readFileSync(WIRELESS_CONFIG_PATH, "utf-8").trim();
  }
  return null;
}

function isWirelessConnected(): boolean {
  const devices = adbRaw("devices");
  return devices.includes(`:${ADB_PORT}\tdevice`);
}

function isUsbConnected(): boolean {
  const devices = adbRaw("devices");
  const lines = devices.split("\n").filter((l) => l.trim() && !l.startsWith("List"));
  return lines.some((l) => l.includes("\tdevice") && !l.includes(`:${ADB_PORT}`));
}

function getUsbDevice(): string | null {
  const devices = adbRaw("devices");
  const lines = devices.split("\n").filter((l) => l.trim() && !l.startsWith("List"));
  const usbLine = lines.find((l) => l.includes("\tdevice") && !l.includes(`:${ADB_PORT}`));
  return usbLine ? usbLine.split("\t")[0] : null;
}

async function setupWirelessAdb(): Promise<boolean> {
  console.log("🔌 Setting up wireless ADB...");

  if (isWirelessConnected()) {
    const savedIp = loadWirelessConfig();
    if (savedIp) {
      targetDevice = `${savedIp}:${ADB_PORT}`;
    }
    console.log("✅ Already connected wirelessly");
    return true;
  }

  const savedIp = loadWirelessConfig();
  if (savedIp) {
    console.log(`📡 Trying saved IP: ${savedIp}...`);
    const result = adbRaw("connect", `${savedIp}:${ADB_PORT}`);
    if (result.includes("connected")) {
      targetDevice = `${savedIp}:${ADB_PORT}`;
      console.log("✅ Connected wirelessly");
      return true;
    }
  }

  if (!isUsbConnected()) {
    console.log("❌ No USB connection and no valid wireless config");
    return false;
  }

  const usbDevice = getUsbDevice();
  if (usbDevice) targetDevice = usbDevice;

  const ip = getDeviceIp();
  if (!ip) {
    console.log("❌ Could not get device IP");
    return false;
  }

  console.log(`📱 Device IP: ${ip}`);
  adb("tcpip", String(ADB_PORT));
  await new Promise((r) => setTimeout(r, 2000));

  const connectResult = adbRaw("connect", `${ip}:${ADB_PORT}`);
  if (connectResult.includes("connected")) {
    targetDevice = `${ip}:${ADB_PORT}`;
    saveWirelessConfig(ip);
    console.log("✅ Connected wirelessly - you can disconnect USB");
    return true;
  }
  return false;
}

// ============== Photo Detection ==============

interface PhotoInfo {
  path: string;
  filename: string;
  timestamp: number;
}

function getLatestPhotos(): PhotoInfo[] {
  try {
    const deviceArg = targetDevice ? `-s ${targetDevice}` : "";
    const cmd = `${ADB_PATH} ${deviceArg} shell 'stat -c "%n %Y" ${DCIM_PATH}/*.jpg 2>/dev/null | sort -k2 -rn | head -5'`;
    const output = execSync(cmd, { encoding: "utf-8" });
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(" ");
        const timestamp = parseInt(parts.pop() || "0", 10) * 1000;
        const path = parts.join(" ");
        return { path, filename: basename(path), timestamp };
      })
      .filter((p) => p.path && p.timestamp > 0);
  } catch {
    return [];
  }
}

function pullPhoto(remotePath: string, localPath: string): boolean {
  try {
    const deviceArg = targetDevice ? `-s ${targetDevice}` : "";
    execSync(`${ADB_PATH} ${deviceArg} pull "${remotePath}" "${localPath}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ============== Gemini OCR ==============

async function transcribeImage(imagePath: string, maxRetries = 3): Promise<string> {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const imageData = readFileSync(imagePath);
  const base64Image = imageData.toString("base64");
  const mimeType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent([
        { inlineData: { data: base64Image, mimeType } },
        `You are an OCR system. Transcribe ALL handwritten text in this image EXACTLY as written.
Output ONLY the transcribed text, preserving line breaks and formatting.
Do not add any commentary or markdown. Just the raw text.`,
      ]);
      return result.response.text().trim();
    } catch (err: any) {
      if (err.message?.includes("429") && attempt < maxRetries) {
        const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        console.log(`⏳ Rate limited, retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Max retries exceeded");
}

// ============== Tmux Helpers ==============

function tmux(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  // All commands go through our custom socket
  const result = spawnSync("tmux", ["-L", TMUX_SOCKET, ...args], { encoding: "utf-8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.toString() || "",
    stderr: result.stderr?.toString() || "",
  };
}

function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

function sessionExists(): boolean {
  return tmux("has-session", "-t", TMUX_SESSION).ok;
}

function setupTmuxAndRun(): void {
  const insideTmux = isInsideTmux();
  const watcherCmd = process.argv.includes("-w") || process.argv.includes("--wireless")
    ? `bun run ${import.meta.dir}/index.ts --wireless --watcher-mode`
    : `bun run ${import.meta.dir}/index.ts --watcher-mode`;

  if (sessionExists()) {
    console.log(`ℹ️  Session exists. Attaching...`);
    attachAndSwitch(insideTmux);
    process.exit(0);
  }

  // Create new session on our custom socket
  console.log(`\n🖥️  Creating tmux session...`);

  tmux("new-session", "-d", "-s", TMUX_SESSION, "-x", "200", "-y", "50");

  // Get initial pane info
  const paneInfo = tmux("list-panes", "-t", TMUX_SESSION, "-F", "#{window_index}.#{pane_index}");
  const firstPane = paneInfo.stdout.trim() || "0.0";
  const winIdx = firstPane.split(".")[0];

  // Left pane (65%): Claude Code (with auto-accept permissions)
  claudePane = `${TMUX_SESSION}:${firstPane}`;
  tmux("send-keys", "-t", claudePane, `cd ${import.meta.dir} && claude --dangerously-skip-permissions`, "Enter");

  // Split horizontally - right side (35%)
  tmux("split-window", "-h", "-t", claudePane, "-p", "35");

  // Get the right pane
  let paneList = tmux("list-panes", "-t", TMUX_SESSION, "-F", "#{pane_index}").stdout.trim().split("\n");
  const rightPane = paneList[paneList.length - 1];

  // Top-right: nvim notes.md
  const nvimPane = `${TMUX_SESSION}:${winIdx}.${rightPane}`;
  tmux("send-keys", "-t", nvimPane, `nvim ${NOTES_FILE}`, "Enter");

  // Split the right pane vertically - bottom for watcher (30% of right side)
  tmux("split-window", "-v", "-t", nvimPane, "-p", "30");

  // Get the new bottom-right pane
  paneList = tmux("list-panes", "-t", TMUX_SESSION, "-F", "#{pane_index}").stdout.trim().split("\n");
  const watcherPane = `${TMUX_SESSION}:${winIdx}.${paneList[paneList.length - 1]}`;

  // Bottom-right: Watcher
  tmux("send-keys", "-t", watcherPane, `cd ${import.meta.dir} && ${watcherCmd}`, "Enter");

  // Focus Claude pane
  tmux("select-pane", "-t", claudePane);

  console.log(`✅ Created session`);
  console.log(`   Left:         Claude Code`);
  console.log(`   Top-right:    nvim notes.md`);
  console.log(`   Bottom-right: Photo watcher\n`);

  attachAndSwitch(insideTmux);
  process.exit(0);
}

function attachAndSwitch(insideTmux: boolean): void {
  if (insideTmux) {
    // Already in tmux - create window and switch to it
    spawnSync("tmux", ["new-window", "-n", "paper-claude"], { encoding: "utf-8" });
    spawnSync("tmux", [
      "send-keys", "-t", "paper-claude",
      `TMUX= tmux -L ${TMUX_SOCKET} attach-session -t ${TMUX_SESSION}`,
      "Enter"
    ], { encoding: "utf-8" });
    // Switch to the new window
    spawnSync("tmux", ["select-window", "-t", "paper-claude"], { encoding: "utf-8" });
    console.log(`✅ Switched to window 'paper-claude'`);
  } else {
    // Not in tmux - attach directly (replaces this process)
    const { execSync } = require("child_process");
    console.log(`📎 Attaching...`);
    execSync(`tmux -L ${TMUX_SOCKET} attach -t ${TMUX_SESSION}`, { stdio: "inherit" });
  }
}

function sendToClaude(message: string): void {
  if (!claudePane) {
    // Find Claude pane
    const paneInfo = tmux("list-panes", "-t", TMUX_SESSION, "-F", "#{window_index}.#{pane_index}");
    const panes = paneInfo.stdout.trim().split("\n");
    claudePane = `${TMUX_SESSION}:${panes[0] || "0.0"}`;
  }

  // Use paste buffer (more reliable than send-keys for complex messages)
  tmux("set-buffer", message);
  tmux("paste-buffer", "-t", claudePane);
  tmux("send-keys", "-t", claudePane, "Enter");
}

// ============== Notes Management ==============

function initNotesFile(): void {
  const header = `# Paper Notes → Claude Code

This file is automatically updated when you take photos of handwritten notes.
Claude Code can read this file to see your instructions.

---

`;
  writeFileSync(NOTES_FILE, header);
}

function appendNote(text: string, photoFilename: string): void {
  noteCounter++;
  const timestamp = new Date().toLocaleTimeString();
  const entry = `
## Note #${noteCounter} (${timestamp})
**Source:** ${photoFilename}

\`\`\`
${text}
\`\`\`

---
`;
  appendFileSync(NOTES_FILE, entry);
}

// ============== Main ==============

async function main() {
  const useWireless = process.argv.includes("--wireless") || process.argv.includes("-w");
  const isWatcherMode = process.argv.includes("--watcher-mode");

  // If not in watcher mode, set up tmux and exit (watcher runs inside tmux)
  if (!isWatcherMode) {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         📱 Paper Note → Claude Code                           ║
╚═══════════════════════════════════════════════════════════════╝
`);

    // Quick ADB check before setting up tmux
    if (useWireless) {
      if (!(await setupWirelessAdb())) {
        process.exit(1);
      }
    } else {
      const devices = adbRaw("devices");
      const hasDevice = devices.includes("\tdevice");
      if (!hasDevice) {
        console.error("❌ No Android device found. Connect via USB or use --wireless");
        process.exit(1);
      }
    }
    console.log("✅ Android device connected");

    // Initialize notes file before tmux
    initNotesFile();

    // Set up tmux and switch to it (this exits the process)
    setupTmuxAndRun();
    return;
  }

  // === Watcher Mode (runs inside tmux pane) ===

  console.log("📱 Photo Watcher Started\n");

  // Set up ADB connection
  if (useWireless) {
    if (!(await setupWirelessAdb())) {
      process.exit(1);
    }
  } else {
    const devices = adbRaw("devices");
    const deviceLines = devices.split("\n").filter((line) => line.trim() && !line.startsWith("List"));
    const authorizedDevice = deviceLines.find((line) => line.includes("\tdevice"));

    if (!authorizedDevice) {
      const unauthorized = deviceLines.find((line) => line.includes("unauthorized"));
      console.error(unauthorized ? "❌ Device unauthorized" : "❌ No device");
      process.exit(1);
    }

    const usbDevice = getUsbDevice();
    if (usbDevice) targetDevice = usbDevice;
  }

  console.log("✅ Device connected");
  console.log("👀 Watching for photos...\n");

  let isProcessing = false;

  // Poll for new photos
  setInterval(async () => {
    if (isProcessing) return;

    const photos = getLatestPhotos();

    for (const photo of photos) {
      if (photo.timestamp < SCRIPT_START_TIME) continue;
      if (processedThisSession.has(photo.filename)) continue;

      console.log(`📸 New photo: ${photo.filename}`);
      isProcessing = true;
      processedThisSession.add(photo.filename);

      try {
        const localPath = join(LOCAL_PHOTOS_DIR, photo.filename);
        console.log("⬇️  Pulling from device...");

        if (!pullPhoto(photo.path, localPath)) {
          console.error("Failed to pull photo");
          continue;
        }

        console.log("📝 Transcribing...");
        const transcribedText = await transcribeImage(localPath);

        if (!transcribedText.trim()) {
          console.log("⚠️  No text detected");
          continue;
        }

        console.log("✍️  Note transcribed:");
        console.log("─".repeat(40));
        console.log(transcribedText);
        console.log("─".repeat(40));

        // Append to notes file
        appendNote(transcribedText, photo.filename);
        console.log(`📄 Added to ${NOTES_FILE}`);

        // Notify Claude
        if (sessionExists()) {
          const notification = `[New handwritten note #${noteCounter} added to notes.md - please read and execute the instructions]`;
          sendToClaude(notification);
          console.log("🤖 Notified Claude Code");
        }

        console.log("");
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
      } finally {
        isProcessing = false;
      }
    }
  }, POLL_INTERVAL);

  process.on("SIGINT", () => {
    console.log("\n👋 Watcher stopped");
    process.exit(0);
  });
}

main();
