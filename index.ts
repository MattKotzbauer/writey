#!/usr/bin/env bun
import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import Anthropic from "@anthropic-ai/sdk";

const ADB_PATH = join(import.meta.dir, "platform-tools", "adb");
const DCIM_PATH = "/sdcard/DCIM/Camera";
const LOCAL_PHOTOS_DIR = join(import.meta.dir, "incoming_photos");
const POLL_INTERVAL = 2000; // 2 seconds
const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

// Track when script started - only process photos taken AFTER this
const SCRIPT_START_TIME = Date.now();

// Load Claude Code's OAuth credentials
function getClaudeAuthToken(): string {
  try {
    const creds = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8"));
    const oauth = creds.claudeAiOauth;

    if (!oauth?.accessToken) {
      throw new Error("No access token found");
    }

    // Check if token is expired
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
      throw new Error("Token expired - please run 'claude' to refresh");
    }

    return oauth.accessToken;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error("Claude Code credentials not found. Please run 'claude' first to authenticate.");
    }
    throw err;
  }
}

// Ensure directories exist
if (!existsSync(LOCAL_PHOTOS_DIR)) {
  mkdirSync(LOCAL_PHOTOS_DIR, { recursive: true });
}

// Track which photos we've already processed this session
const processedThisSession = new Set<string>();

// ADB helpers
function adb(...args: string[]): string {
  try {
    return execSync(`${ADB_PATH} ${args.join(" ")}`, { encoding: "utf-8" });
  } catch (e: any) {
    console.error(`ADB error: ${e.message}`);
    return "";
  }
}

interface PhotoInfo {
  path: string;
  filename: string;
  timestamp: number; // Unix timestamp in ms
}

function getLatestPhotos(): PhotoInfo[] {
  // Get the newest photos with timestamps using stat
  // Wrap whole command in single quotes so shell doesn't mangle it
  try {
    const cmd = `${ADB_PATH} shell 'stat -c "%n %Y" ${DCIM_PATH}/*.jpg 2>/dev/null | sort -k2 -rn | head -5'`;
    const output = execSync(cmd, { encoding: "utf-8" });

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(" ");
        const timestamp = parseInt(parts.pop() || "0", 10) * 1000; // Convert to ms
        const path = parts.join(" "); // Handle spaces in filename
        return {
          path,
          filename: basename(path),
          timestamp,
        };
      })
      .filter(p => p.path && p.timestamp > 0);
  } catch {
    return [];
  }
}

function pullPhoto(remotePath: string, localPath: string): boolean {
  try {
    execSync(`${ADB_PATH} pull "${remotePath}" "${localPath}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Transcribe image using Anthropic SDK with Claude Code's auth
async function transcribeImage(imagePath: string, authToken: string): Promise<string> {
  console.log("📝 Transcribing handwritten note...");

  const client = new Anthropic({ authToken });

  const imageData = readFileSync(imagePath);
  const base64Image = imageData.toString("base64");
  const mediaType = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64Image,
            },
          },
          {
            type: "text",
            text: `Transcribe this handwritten note EXACTLY as written. The note likely contains instructions for a coding assistant.

Output ONLY the transcribed text, preserving line breaks, formatting, and any technical notation.
Do not add commentary or markdown formatting. Just the raw transcribed text.`,
          },
        ],
      },
    ],
  });

  const textContent = response.content.find((c) => c.type === "text");
  return textContent?.text || "";
}

// Execute via Claude Code
async function executeWithClaudeCode(transcribedText: string): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("📋 TRANSCRIBED NOTE:");
  console.log("=".repeat(60));
  console.log(transcribedText);
  console.log("=".repeat(60) + "\n");

  console.log("🤖 Sending to Claude Code...\n");
  console.log("-".repeat(60));

  const systemPrompt = `This request was transcribed from a handwritten paper note. The user wrote this on paper and photographed it.

Key behaviors:
- Execute the request as written
- If there are any errors, explain them clearly and attempt to fix them
- Show your work - let the developer see what you're doing
- If the handwriting transcription seems unclear, make reasonable interpretations
- After completing the task, briefly summarize what was done`;

  // Run claude with the transcribed text and context
  const claude = spawn("claude", [
    "--print",
    "--append-system-prompt", systemPrompt,
    transcribedText
  ], {
    stdio: ["inherit", "inherit", "inherit"],
    cwd: process.cwd(),
  });

  return new Promise((resolve, reject) => {
    claude.on("close", (code) => {
      console.log("-".repeat(60));
      if (code === 0) {
        console.log("\n✅ Claude Code completed successfully\n");
      } else {
        console.log(`\n⚠️  Claude Code exited with code ${code}\n`);
      }
      resolve();
    });
    claude.on("error", (err) => {
      console.error("Failed to start Claude Code:", err.message);
      reject(err);
    });
  });
}

// Main watcher loop
async function watchForPhotos() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           📱 Paper Note → Claude Code Bridge               ║
╠════════════════════════════════════════════════════════════╣
║  1. Write your note on paper                               ║
║  2. Take a photo with your Android phone                   ║
║  3. The system will automatically:                         ║
║     • Detect the new photo                                 ║
║     • Transcribe your handwriting                          ║
║     • Send instructions to Claude Code                     ║
╚════════════════════════════════════════════════════════════╝
`);

  // Get Claude Code's auth token
  let authToken: string;
  try {
    authToken = getClaudeAuthToken();
    console.log("✅ Using Claude Code authentication\n");
  } catch (err: any) {
    console.error(`❌ ${err.message}\n`);
    process.exit(1);
  }

  // Check device connection - look for a device line that ends with "device" (not "unauthorized")
  const devices = adb("devices");
  const deviceLines = devices.split("\n").filter(line => line.trim() && !line.startsWith("List"));
  const authorizedDevice = deviceLines.find(line => line.includes("\tdevice"));

  if (!authorizedDevice) {
    const unauthorizedDevice = deviceLines.find(line => line.includes("unauthorized"));
    if (unauthorizedDevice) {
      console.error("❌ Android device found but NOT AUTHORIZED!");
      console.error("   👉 Check your phone for a USB debugging prompt and tap 'Allow'\n");
    } else {
      console.error("❌ No Android device found!");
      console.error("   Make sure:");
      console.error("   1. USB debugging is enabled on your phone");
      console.error("   2. Your phone is connected via USB\n");
    }
    process.exit(1);
  }

  console.log("✅ Android device connected\n");
  console.log("👀 Watching for NEW photos (taken after script started)...\n");

  let isProcessing = false;

  // Poll for new photos
  setInterval(async () => {
    if (isProcessing) return;

    const photos = getLatestPhotos();

    for (const photo of photos) {
      // Skip photos taken before script started
      if (photo.timestamp < SCRIPT_START_TIME) continue;

      // Skip already processed
      if (processedThisSession.has(photo.filename)) continue;

      // New photo detected!
      console.log(`\n📸 New photo detected: ${photo.filename}`);
      isProcessing = true;
      processedThisSession.add(photo.filename);

      try {
        // Pull the photo
        const localPath = join(LOCAL_PHOTOS_DIR, photo.filename);
        console.log("⬇️  Pulling from device...");

        if (!pullPhoto(photo.path, localPath)) {
          console.error("Failed to pull photo");
          continue;
        }

        // Transcribe
        const transcribedText = await transcribeImage(localPath, authToken);

        if (!transcribedText.trim()) {
          console.log("⚠️  No text detected in image, skipping...");
          continue;
        }

        // Execute with Claude Code
        await executeWithClaudeCode(transcribedText);

        console.log("👀 Watching for new photos...\n");
      } catch (err: any) {
        console.error(`Error processing photo: ${err.message}`);
      } finally {
        isProcessing = false;
      }
    }
  }, POLL_INTERVAL);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down...\n");
  process.exit(0);
});

// Start watching
watchForPhotos();
