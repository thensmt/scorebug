#!/usr/bin/env node
/**
 * NSMT AI Review Board — Automated Gemini Security/Architecture Review
 *
 * Usage:
 *   node scripts/gemini-review.js <review-package.md> [--attach file1 file2 ...]
 *
 * Examples:
 *   node scripts/gemini-review.js gemini-review-package/PHASE_A_SECURITY_REVIEW.md
 *   node scripts/gemini-review.js gemini-review-package/PHASE_A_SECURITY_REVIEW.md --attach database.rules.json functions/index.js
 *
 * Reads GEMINI_API_KEY from .env in the repo root.
 * Writes response to gemini-review-package/GEMINI_RESPONSE_<timestamp>.md
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// ── Load API key from .env ──
const ROOT = path.resolve(__dirname, "..");
const envPath = path.join(ROOT, ".env");
if (!fs.existsSync(envPath)) {
  console.error("ERROR: .env file not found at", envPath);
  process.exit(1);
}
const envContents = fs.readFileSync(envPath, "utf8");
const keyMatch = envContents.match(/GEMINI_API_KEY=(.+)/);
if (!keyMatch) {
  console.error("ERROR: GEMINI_API_KEY not found in .env");
  process.exit(1);
}
const API_KEY = keyMatch[1].trim();

// ── Parse CLI args ──
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/gemini-review.js <review-package.md> [--attach file1 file2 ...]");
  process.exit(1);
}

const packagePath = path.resolve(ROOT, args[0]);
if (!fs.existsSync(packagePath)) {
  console.error("ERROR: Review package not found:", packagePath);
  process.exit(1);
}

// Collect attached files
const attachFiles = [];
const attachIdx = args.indexOf("--attach");
if (attachIdx !== -1) {
  for (let i = attachIdx + 1; i < args.length; i++) {
    const fp = path.resolve(ROOT, args[i]);
    if (fs.existsSync(fp)) {
      attachFiles.push({ name: args[i], content: fs.readFileSync(fp, "utf8") });
    } else {
      console.warn("WARN: Attached file not found, skipping:", args[i]);
    }
  }
}

// ── Build prompt ──
let prompt = fs.readFileSync(packagePath, "utf8");

if (attachFiles.length > 0) {
  prompt += "\n\n---\n\n# ATTACHED SOURCE FILES\n\n";
  for (const f of attachFiles) {
    prompt += `## ${f.name}\n\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
  }
}

console.log(`Sending review to Gemini (${Math.round(prompt.length / 1024)}KB prompt, ${attachFiles.length} attached files)...`);

// ── Call Gemini API ──
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const body = JSON.stringify({
  contents: [{ parts: [{ text: prompt }] }],
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 65536,
  },
});

const urlObj = new URL(url);
const options = {
  hostname: urlObj.hostname,
  path: urlObj.pathname + urlObj.search,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
};

const req = https.request(options, (res) => {
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.error(`ERROR: Gemini API returned ${res.statusCode}`);
      console.error(data);
      process.exit(1);
    }

    try {
      const json = JSON.parse(data);
      const text =
        json.candidates?.[0]?.content?.parts?.[0]?.text ||
        "ERROR: No text in response";

      // Write response to file
      const outDir = path.join(ROOT, "gemini-review-package");
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outPath = path.join(outDir, `GEMINI_RESPONSE_${timestamp}.md`);

      const output = `# Gemini Security Review Response\n\nModel: ${MODEL}\nTimestamp: ${new Date().toISOString()}\nPackage: ${args[0]}\n\n---\n\n${text}`;

      fs.writeFileSync(outPath, output);
      console.log(`\nDone! Response written to: ${path.relative(ROOT, outPath)}`);
      console.log(`Response length: ${text.length} chars`);

      // Also print to stdout for piping
      console.log("\n" + "=".repeat(60));
      console.log(text);
    } catch (e) {
      console.error("ERROR: Failed to parse Gemini response:", e.message);
      console.error(data.slice(0, 500));
      process.exit(1);
    }
  });
});

req.on("error", (e) => {
  console.error("ERROR: Request failed:", e.message);
  process.exit(1);
});

req.write(body);
req.end();
