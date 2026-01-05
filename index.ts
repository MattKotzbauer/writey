#!/usr/bin/env bun
import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_API_KEY = "AIzaSyC7GdnlfOoHS5me82y-_vx9GmgeCW5Tqbk";

const ADB_PATH = join(import.meta.dir, "platform-tools", "adb");
const DCIM_PATH = "/sdcard/DCIM/Camera";
const LOCAL_PHOTOS_DIR = join(import.meta.dir, "incoming_photos");
const POLL_INTERVAL = 2000;
const WIRELESS_CONFIG_PATH = join(import.meta.dir, ".wireless_adb");
const ADB_PORT = 5555;

const SCRIPT_START_TIME = Date.now();

if (!existsSync(LOCAL_PHOTOS_DIR)) {
  mkdirSync(LOCAL_PHOTOS_DIR, { recursive: true });
}

const processedThisSession = new Set<string>();

// Track current device target (set when wireless connects)
let targetDevice: string | null = null;

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
  // ADB without device selection (for 'devices' command, etc.)
  try {
    return execSync(`${ADB_PATH} ${args.join(" ")}`, { encoding: "utf-8" });
  } catch {
    return "";
  }
}

// ============== Wireless ADB ==============

function getDeviceIp(): string | null {
  try {
    // Get IP from wlan0 interface
    const output = adb("shell", "ip", "addr", "show", "wlan0");
    const match = output.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function saveWirelessConfig(ip: string): void {
  writeFileSync(WIRELESS_CONFIG_PATH, ip);
  console.log(`📝 Saved wireless config: ${ip}`);
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
  console.log("\n🔌 Setting up wireless ADB...\n");

  // Check if already connected wirelessly
  if (isWirelessConnected()) {
    const savedIp = loadWirelessConfig();
    if (savedIp) {
      targetDevice = `${savedIp}:${ADB_PORT}`;
    }
    console.log("✅ Already connected wirelessly");
    return true;
  }

  // Try saved config first
  const savedIp = loadWirelessConfig();
  if (savedIp) {
    console.log(`📡 Trying saved IP: ${savedIp}...`);
    const result = adbRaw("connect", `${savedIp}:${ADB_PORT}`);
    if (result.includes("connected")) {
      targetDevice = `${savedIp}:${ADB_PORT}`;
      console.log("✅ Connected wirelessly using saved config");
      return true;
    }
    console.log("⚠️  Saved IP didn't work, need USB to reconfigure");
  }

  // Need USB to set up wireless
  if (!isUsbConnected()) {
    console.log("❌ No USB connection and no valid wireless config");
    console.log("   Please connect via USB once to enable wireless mode");
    return false;
  }

  // Target the USB device specifically for setup
  const usbDevice = getUsbDevice();
  if (usbDevice) {
    targetDevice = usbDevice;
  }

  // Get device IP
  const ip = getDeviceIp();
  if (!ip) {
    console.log("❌ Could not get device IP (is WiFi enabled on phone?)");
    return false;
  }

  console.log(`📱 Device IP: ${ip}`);

  // Enable TCP/IP mode
  console.log("🔄 Enabling ADB over TCP/IP...");
  const tcpResult = adb("tcpip", String(ADB_PORT));
  console.log(`   ${tcpResult.trim() || "TCP/IP mode enabled"}`);

  // Wait for device to restart ADB daemon
  await new Promise((r) => setTimeout(r, 2000));

  // Connect wirelessly
  console.log(`🔗 Connecting to ${ip}:${ADB_PORT}...`);
  const connectResult = adbRaw("connect", `${ip}:${ADB_PORT}`);

  if (connectResult.includes("connected")) {
    // Switch target to wireless device
    targetDevice = `${ip}:${ADB_PORT}`;
    console.log("✅ Connected wirelessly!");
    saveWirelessConfig(ip);

    console.log("\n📵 You can now disconnect the USB cable!\n");
    return true;
  } else {
    console.log(`❌ Failed to connect: ${connectResult}`);
    return false;
  }
}

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

async function transcribeImage(imagePath: string): Promise<string> {
  console.log("📝 Transcribing with Gemini...");

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const imageData = readFileSync(imagePath);
  const base64Image = imageData.toString("base64");
  const mimeType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

  const result = await model.generateContent([
    { inlineData: { data: base64Image, mimeType } },
    `You are an OCR system. Transcribe ALL handwritten text in this image EXACTLY as written.
Output ONLY the transcribed text, preserving line breaks and formatting.
Do not add any commentary or markdown. Just the raw text.`,
  ]);

  return result.response.text().trim();
}

// ============== Claude Code Integration ==============

let isFirstMessage = true;

async function sendToClaude(text: string): Promise<void> {
  console.log("\n" + "=".repeat(50));
  console.log("📋 TRANSCRIBED NOTE:");
  console.log("=".repeat(50));
  console.log(text);
  console.log("=".repeat(50) + "\n");

  const args = ["--print"];

  // Continue session for subsequent messages
  if (!isFirstMessage) {
    args.push("--continue");
  }

  args.push(text);

  return new Promise((resolve, reject) => {
    console.log("🤖 Sending to Claude Code" + (isFirstMessage ? "" : " (continuing session)") + "...\n");

    const claude = spawn("claude", args, {
      stdio: ["inherit", "inherit", "inherit"],
      cwd: process.cwd(),
    });

    claude.on("close", (code) => {
      isFirstMessage = false;
      console.log("\n" + "-".repeat(50));
      if (code === 0) {
        console.log("✅ Claude completed\n");
      } else {
        console.log(`⚠️  Claude exited with code ${code}\n`);
      }
      resolve();
    });

    claude.on("error", (err) => {
      console.error("Error:", err.message);
      reject(err);
    });
  });
}

// ============== Main ==============

async function main() {
  const useWireless = process.argv.includes("--wireless") || process.argv.includes("-w");

  console.log(`
╔════════════════════════════════════════════════════════════╗
║           📱 Paper Note → Claude Code                      ║
╠════════════════════════════════════════════════════════════╣
║  1. Write on paper, take photo with your phone             ║
║  2. Gemini OCR transcribes the handwriting                 ║
║  3. Claude Code executes (session persists via --continue) ║
║  4. Bills to your Claude Code subscription                 ║
╠════════════════════════════════════════════════════════════╣
║  Mode: ${useWireless ? "📶 Wireless ADB" : "🔌 USB ADB"}                                     ║
║  Tip: Run with --wireless or -w for wireless mode          ║
╚════════════════════════════════════════════════════════════╝
`);

  // Set up connection (wireless or USB)
  if (useWireless) {
    const connected = await setupWirelessAdb();
    if (!connected) {
      process.exit(1);
    }
  } else {
    // Check USB device
    const devices = adbRaw("devices");
    const deviceLines = devices.split("\n").filter((line) => line.trim() && !line.startsWith("List"));
    const authorizedDevice = deviceLines.find((line) => line.includes("\tdevice"));

    if (!authorizedDevice) {
      const unauthorized = deviceLines.find((line) => line.includes("unauthorized"));
      if (unauthorized) {
        console.error("❌ Device unauthorized - tap 'Allow' on your phone\n");
      } else {
        console.error("❌ No Android device found\n");
      }
      process.exit(1);
    }

    // In USB mode, set target device explicitly if multiple devices
    const usbDevice = getUsbDevice();
    if (usbDevice) {
      targetDevice = usbDevice;
    }
  }

  console.log("✅ Android device connected");
  console.log("👀 Watching for new photos...\n");

  let isProcessing = false;

  // Poll for new photos
  setInterval(async () => {
    if (isProcessing) return;

    const photos = getLatestPhotos();

    for (const photo of photos) {
      if (photo.timestamp < SCRIPT_START_TIME) continue;
      if (processedThisSession.has(photo.filename)) continue;

      console.log(`\n📸 New photo detected: ${photo.filename}`);
      isProcessing = true;
      processedThisSession.add(photo.filename);

      try {
        const localPath = join(LOCAL_PHOTOS_DIR, photo.filename);
        console.log("⬇️  Pulling from device...");

        if (!pullPhoto(photo.path, localPath)) {
          console.error("Failed to pull photo");
          continue;
        }

        const transcribedText = await transcribeImage(localPath);

        if (!transcribedText.trim()) {
          console.log("⚠️  No text detected, skipping...");
          continue;
        }

        await sendToClaude(transcribedText);

        console.log("👀 Watching for new photos...\n");
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
      } finally {
        isProcessing = false;
      }
    }
  }, POLL_INTERVAL);

  process.on("SIGINT", () => {
    console.log("\n\n👋 Shutting down...");
    process.exit(0);
  });
}

main();
