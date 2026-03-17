import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const PROJECT_DIR = path.join(os.homedir(), "kate", "projects", "arduino");
const USER_ARDUINO = path.join(os.homedir(), "Arduino");
const USER_LIBS = path.join(USER_ARDUINO, "libraries");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}


// Before compile: read actual header files, learn real class names, fix code
function preCompileFix(dir: string) {
  const inoFiles = fs.readdirSync(dir).filter(f => f.endsWith(".ino"));
  for (const file of inoFiles) {
    const fp = path.join(dir, file);
    let code = fs.readFileSync(fp, "utf-8");
    let fixed = false;

    // Find all #include <X.h> and read the actual headers
    const includes = [...code.matchAll(/#include\s*<([^>]+\.h)>/g)].map(m => m[1]);

    for (const hName of includes) {
      // Find header in user libraries
      let hPath = "";
      try {
        const { execSync } = require("child_process");
        hPath = execSync("find " + JSON.stringify(USER_LIBS) + " -name " + JSON.stringify(hName) + " -type f 2>/dev/null | head -1", { encoding: "utf-8", timeout: 5000 }).trim();
      } catch {}
      if (!hPath) continue;

      let header = "";
      try { header = fs.readFileSync(hPath, "utf-8"); } catch { continue; }

      // Learn real class names from "class ClassName"
      const classes = [...header.matchAll(/^\s*class\s+(\w+)/gm)].map(m => m[1]);

      // Learn which begin() returns void
      for (const cls of classes) {
        const beginMatch = header.match(new RegExp("void\\s+begin\\s*\\("));
        const isVoidBegin = !!beginMatch;

        // Fix wrong class names: if code uses "SparkFun"+ClassName but header has just ClassName
        const wrong = "SparkFun" + cls;
        if (code.includes(wrong) && wrong !== cls) {
          code = code.split(wrong).join(cls);
          fixed = true;
        }

        if (isVoidBegin) {
          // Find variables of this class
          const varMatches = [...code.matchAll(new RegExp(cls + "\\s+(\\w+)\\s*[;(=]", "g"))].map(m => m[1]);
          for (const v of varMatches) {
            // Fix: if (!var.begin()) or if (var.begin() == false)
            const patterns = [
              new RegExp("if\\s*\\(\\s*!" + v + "\\.begin\\(\\)\\s*\\)", "g"),
              new RegExp("if\\s*\\(" + v + "\\.begin\\(\\)\\s*==\\s*false\\s*\\)", "g"),
            ];
            for (const pat of patterns) {
              if (pat.test(code)) {
                code = code.replace(pat, v + ".begin(); if (false)");
                fixed = true;
              }
            }
          }
        }
      }
    }

    if (fixed) fs.writeFileSync(fp, code);
  }
}

// ── Boards ─────────────────────────────────────────────────
const BOARDS: Record<string, { name: string; fqbn: string; wifi: string; pins: Record<string, string> }> = {
  "esp8266":     { name: "ESP8266 D1 Mini",   fqbn: "esp8266:esp8266:d1_mini",          wifi: "ESP8266WiFi.h", pins: { SDA: "4", SCL: "5", LED: "2", A0: "A0" } },
  "d1mini":      { name: "ESP8266 D1 Mini",   fqbn: "esp8266:esp8266:d1_mini",          wifi: "ESP8266WiFi.h", pins: { SDA: "4", SCL: "5", LED: "2", A0: "A0" } },
  "nodemcu":     { name: "ESP8266 NodeMCU",   fqbn: "esp8266:esp8266:nodemcuv2",        wifi: "ESP8266WiFi.h", pins: { SDA: "4", SCL: "5", LED: "2", A0: "A0" } },
  "esp32":       { name: "ESP32 DevKit",      fqbn: "esp32:esp32:esp32",                wifi: "WiFi.h",        pins: { SDA: "21", SCL: "22", LED: "2", A0: "36" } },
  "esp32s2":     { name: "ESP32-S2 Mini",     fqbn: "esp32:esp32:esp32s2",              wifi: "WiFi.h",        pins: { SDA: "8", SCL: "9", LED: "15" } },
  "esp32s3":     { name: "ESP32-S3 DevKit",   fqbn: "esp32:esp32:esp32s3",              wifi: "WiFi.h",        pins: { SDA: "8", SCL: "9", LED: "48" } },
  "esp32c3":     { name: "ESP32-C3 Mini",     fqbn: "esp32:esp32:esp32c3",              wifi: "WiFi.h",        pins: { SDA: "8", SCL: "9", LED: "8" } },
  "esp32c6":     { name: "ESP32-C6",          fqbn: "esp32:esp32:esp32c6",              wifi: "WiFi.h",        pins: { SDA: "6", SCL: "7", LED: "8" } },
  "esp32h2":     { name: "ESP32-H2",          fqbn: "esp32:esp32:esp32h2",              wifi: "",              pins: { SDA: "1", SCL: "0", LED: "8" } },
  "atmega1284p": { name: "ATmega1284P",       fqbn: "MightyCore:avr:1284",              wifi: "",              pins: { SDA: "17", SCL: "16", LED: "13" } },
  "samd21":      { name: "SAMD21 Zero",       fqbn: "arduino:samd:arduino_zero_native",  wifi: "",             pins: { SDA: "20", SCL: "21", LED: "13" } },
};

function resolveBoard(input: string): string {
  const low = input.toLowerCase().replace(/[_\-\s]/g, "");
  if (BOARDS[low]) return low;
  if (low.includes("8266") || low.includes("d1mini") || low.includes("wemos")) return "esp8266";
  if (low.includes("c6")) return "esp32c6";
  if (low.includes("h2")) return "esp32h2";
  if (low.includes("c3")) return "esp32c3";
  if (low.includes("s2")) return "esp32s2";
  if (low.includes("s3")) return "esp32s3";
  if (low.includes("esp32")) return "esp32";
  if (low.includes("1284")) return "atmega1284p";
  if (low.includes("samd") || low.includes("zero")) return "samd21";
  return "esp32";
}

// ── Search existing projects ───────────────────────────────
function searchExisting(keywords: string): { name: string; path: string; ino: string }[] {
  if (!fs.existsSync(USER_ARDUINO)) return [];
  const words = keywords.toLowerCase().replace(/[_\-]/g, " ").split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return [];

  const dirs = fs.readdirSync(USER_ARDUINO).filter(d => {
    try { return fs.statSync(path.join(USER_ARDUINO, d)).isDirectory() && d !== "libraries"; } catch { return false; }
  });

  return dirs.map(d => {
    const dLow = d.toLowerCase().replace(/[_\-]/g, " ");
    let score = 0;
    for (const w of words) {
      if (dLow.includes(w)) {
        // Specific words score higher than generic ones
        if (w.length > 5) score += 30;       // htu21d, deepsleep, bme280
        else if (w.length > 3) score += 15;  // mqtt, esp32
        else score += 5;                      // d1, led
      }
    }
    return { name: d, score };
  }).filter(s => s.score >= 30).sort((a, b) => b.score - a.score).slice(0, 10).map(s => {
    const dir = path.join(USER_ARDUINO, s.name);
    const inos = fs.readdirSync(dir).filter(f => f.endsWith(".ino"));
    return { name: s.name, path: dir, ino: inos[0] || "" };
  });
}

function readCode(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
}

// ── Library search ─────────────────────────────────────────
function findLocalLib(name: string): { found: boolean; name: string; headers: string[]; include: string } {
  if (!fs.existsSync(USER_LIBS)) return { found: false, name: "", headers: [], include: "" };
  const terms = name.toLowerCase().replace(/[_\-\s]+/g, " ").split(" ").filter(w => w.length > 2);

  const libs = fs.readdirSync(USER_LIBS).filter(d => {
    try { return fs.statSync(path.join(USER_LIBS, d)).isDirectory(); } catch { return false; }
  });

  const scored = libs.map(l => {
    const lLow = l.toLowerCase().replace(/[_\-]/g, " ");
    let score = 0;
    for (const t of terms) { if (lLow.includes(t)) score += 10; }
    return { name: l, score };
  }).filter(s => s.score >= 10).sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { found: false, name: "", headers: [], include: "" };

  const best = scored[0].name;
  const libPath = path.join(USER_LIBS, best);
  let headers: string[] = [];
  try { headers.push(...fs.readdirSync(libPath).filter(f => f.endsWith(".h"))); } catch {}
  try { headers.push(...fs.readdirSync(path.join(libPath, "src")).filter(f => f.endsWith(".h"))); } catch {}

  return { found: true, name: best, headers, include: "#include <" + (headers[0] || best + ".h") + ">" };
}

// ── Skill ──────────────────────────────────────────────────
const arduino: Skill = {
  id: "builtin.arduino",
  name: "Arduino & ESP32",
  description: "Create, compile, upload Arduino sketches. Search 500+ existing projects. Supports ESP8266, ESP32, S2, S3, C3, C6, H2, ATmega1284P, SAMD21. Always writes COMPLETE working code.",
  version: "2.0.0",
  tools: [
    { name: "arduino_new", description: "Create new Arduino project. Searches existing projects first, then generates COMPLETE working code — never blank. Uses user's WiFi (mantiz010/DavidCross010), MQTT (172.168.1.8), and local libraries.", parameters: [
      { name: "name", type: "string", description: "Project name", required: true },
      { name: "board", type: "string", description: "Board: esp8266, esp32, esp32s2, esp32s3, esp32c3, esp32c6, esp32h2", required: true },
      { name: "description", type: "string", description: "What the project should do — sensors, protocols, features", required: false },
    ]},
    { name: "arduino_write", description: "Write COMPLETE code to a sketch. Must be full compilable code, not stubs.", parameters: [
      { name: "project", type: "string", description: "Project name", required: true },
      { name: "code", type: "string", description: "Full Arduino code — must compile", required: true },
    ]},
    { name: "arduino_read", description: "Read a sketch from Kate projects or ~/Arduino/", parameters: [
      { name: "project", type: "string", description: "Project name", required: true },
    ]},
    { name: "arduino_search", description: "Search user's 500+ Arduino projects by keywords", parameters: [
      { name: "query", type: "string", description: "Keywords like: mqtt deepsleep htu21d esp8266", required: true },
    ]},
    { name: "arduino_find_similar", description: "Find existing projects similar to a description and show the code", parameters: [
      { name: "description", type: "string", description: "What you're looking for", required: true },
    ]},
    { name: "arduino_compile", description: "Compile a sketch and show result", parameters: [
      { name: "project", type: "string", description: "Project name", required: true },
      { name: "board", type: "string", description: "Board override", required: false },
    ]},
    { name: "arduino_upload", description: "Upload compiled sketch to board", parameters: [
      { name: "project", type: "string", description: "Project name", required: true },
      { name: "port", type: "string", description: "Serial port", required: true },
      { name: "board", type: "string", description: "Board override", required: false },
    ]},
    { name: "arduino_install_lib", description: "Install library — checks local ~/Arduino/libraries first", parameters: [
      { name: "library", type: "string", description: "Library name", required: true },
    ]},
    { name: "arduino_list_boards", description: "List supported boards with FQBN and pin mappings", parameters: [] },
    { name: "arduino_list_projects", description: "List Kate's Arduino projects", parameters: [] },
    { name: "arduino_list_libs", description: "List all installed Arduino libraries", parameters: [] },
    { name: "arduino_setup", description: "Install Arduino CLI board cores", parameters: [
      { name: "boards", type: "string", description: "esp8266, esp32, or both", required: true },
    ]},
    { name: "arduino_list_ports", description: "List available serial ports", parameters: [] },
  ],

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {

      case "arduino_new": {
        const name = (args.name as string).trim().replace(/\s+/g, "-");
        const boardInput = (args.board as string) || "esp32";
        const board = resolveBoard(boardInput);
        const b = BOARDS[board] || BOARDS["esp32"];
        const desc = (args.description as string || "") || name;

        // ALWAYS search existing projects first
        const matches = searchExisting(name + " " + desc);
        let existingInfo = "";
        if (matches.length > 0) {
          existingInfo = "📂 Found " + matches.length + " similar project(s):\n" +
            matches.slice(0, 5).map(m => "  • ~/Arduino/" + m.name).join("\n") + "\n\n";
        }

        // Create project with REAL code — model writes this via arduino_write
        ensureDir(PROJECT_DIR);
        const projDir = path.join(PROJECT_DIR, name);
        ensureDir(projDir);

        // Save metadata
        fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify({
          name, board, fqbn: b.fqbn, description: desc, created: Date.now(),
        }));

        // Write a starter .ino that tells the model to use arduino_write
        const starterCode = `// ${name} — ${b.name}
// Board: ${board} (${b.fqbn})
// Description: ${desc}
// WiFi: mantiz010 / DavidCross010
// MQTT: 172.168.1.8:1883 user=mantiz010 pass=DavidCross010
//
// This is a placeholder — use arduino_write to write the full code.
// The AI model (qwen2.5-coder:14b) will generate complete working code.

void setup() {
  Serial.begin(115200);
}

void loop() {
}
`;

        fs.writeFileSync(path.join(projDir, name + ".ino"), starterCode);

        return existingInfo +
          "✅ Project created: " + name + "\n" +
          "Board: " + b.name + " (" + b.fqbn + ")\n" +
          "Location: " + projDir + "\n\n" +
          "**Now use arduino_write to write COMPLETE COMPILABLE code.**\n" +
          "WiFi: SSID=mantiz010, PASS=DavidCross010\n" +
          "Use ONLY what the user asked for — MQTT OR ETBus, not both.";
      }

      case "arduino_write": {
        // Accept any arg combo the model sends
        const code = (args.code || args.content || "") as string;
        if (!code || code.length < 50) return "❌ Code too short.";
        
        // Get project name from whatever arg exists
        let name = (args.project || args.name || "") as string;
        let fullPath = (args.path || "") as string;
        
        // Expand ~
        if (fullPath.startsWith("~")) fullPath = fullPath.replace("~", os.homedir());
        
        // Extract name from path if no name given
        if (!name && fullPath) {
          const parts = fullPath.split("/").filter(Boolean);
          name = parts[parts.length - 1] || "";
          // Strip .ino extension if present
          if (name.endsWith(".ino")) name = name.replace(/\.ino$/, "");
          // If name is a parent dir name, go up
          if (name === "arduino" || name === "projects" || name === "kate" || !name) {
            name = parts[parts.length - 2] || "untitled";
            if (name.endsWith(".ino")) name = name.replace(/\.ino$/, "");
          }
        }
        if (!name) name = "untitled";
        // Always strip .ino from name
        name = name.replace(/\.ino$/, "");
        
        // Save to Kate projects
        const projDir = path.join(PROJECT_DIR, name);
        ensureDir(projDir);
        const inoPath = path.join(projDir, name + ".ino");
        fs.writeFileSync(inoPath, code);
        
        // Also save project.json if not exists
        const metaPath = path.join(projDir, "project.json");
        if (!fs.existsSync(metaPath)) {
          fs.writeFileSync(metaPath, JSON.stringify({ name, board: "esp8266", created: Date.now() }));
        }
        
        const preview = code.length > 3000 ? code.slice(0, 3000) + "\n// ... (" + code.length + " chars)" : code;
        return "✅ Written: " + name + "/" + name + ".ino (" + code.length + " chars)\n\n```cpp\n" + preview + "\n```";
      }

      case "arduino_read": {
        let project = ((args.project || args.path || args.name || "") as string).trim();
        if (project.startsWith("~")) project = project.replace("~", os.homedir());
        // Check Kate projects
        let inoPath = path.join(PROJECT_DIR, project, project + ".ino");
        if (!fs.existsSync(inoPath)) {
          // Check ~/Arduino
          const userDir = path.join(USER_ARDUINO, project);
          if (fs.existsSync(userDir)) {
            const inos = fs.readdirSync(userDir).filter(f => f.endsWith(".ino"));
            if (inos.length > 0) inoPath = path.join(userDir, inos[0]);
          }
        }
        if (!fs.existsSync(inoPath)) return "❌ Not found: " + project + "\nSearch with: arduino_search";
        const code = readCode(inoPath);
        return "📄 " + inoPath + "\n\n```cpp\n" + code + "\n```";
      }

      case "arduino_search": {
        const query = args.query as string;
        const matches = searchExisting(query);
        if (matches.length === 0) return "No projects found for: " + query + "\nTry different keywords.";
        return "Found " + matches.length + " project(s):\n\n" +
          matches.map((m, i) => (i + 1) + ". ~/Arduino/" + m.name + (m.ino ? " (" + m.ino + ")" : "")).join("\n");
      }

      case "arduino_find_similar": {
        const desc = (args.description as string);
        const matches = searchExisting(desc);
        if (matches.length === 0) return "No similar projects found. Try: arduino_search with different keywords.";
        const best = matches[0];
        if (!best.ino) return "Found ~/Arduino/" + best.name + " but no .ino file.";
        const code = readCode(path.join(best.path, best.ino));
        const preview = code.length > 4000 ? code.slice(0, 4000) + "\n// ... (" + code.length + " chars)" : code;
        return "**Best match: ~/Arduino/" + best.name + "**\n\n```cpp\n" + preview + "\n```" +
          (matches.length > 1 ? "\n\nAlso similar:\n" + matches.slice(1, 5).map(m => "  • " + m.name).join("\n") : "");
      }

      case "arduino_compile": {
        let project = ((args.project || args.path || args.name || "") as string).trim();
        if (project.startsWith("~")) project = project.replace("~", os.homedir());
        let projDir = "";
        if (project.startsWith("/") && fs.existsSync(project)) {
          projDir = project;
        } else {
          const name = project.includes("/") ? project.split("/").filter(Boolean).pop() || project : project;
          projDir = path.join(PROJECT_DIR, name);
          if (!fs.existsSync(projDir)) projDir = path.join(USER_ARDUINO, name);
        }
        if (!fs.existsSync(projDir)) return "❌ Not found: " + project;

        let fqbn = "";
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(projDir, "project.json"), "utf-8"));
          const brd = BOARDS[meta.board];
          fqbn = brd ? brd.fqbn : meta.fqbn || "";
        } catch {}
        if (args.board) { const brd = BOARDS[resolveBoard(args.board as string)]; if (brd) fqbn = brd.fqbn; }
        if (!fqbn) fqbn = "esp32:esp32:esp32";

        try {
          const { stdout, stderr } = await execAsync(
            `arduino-cli compile --fqbn "${fqbn}" --libraries "${USER_LIBS}" "${projDir}" 2>&1`,
            { timeout: 120000 }
          );
          const clean = (stdout + "\n" + stderr).replace(/\x1b\[[0-9;]*m/g, "").trim();
          const sizeLines = clean.split("\n").filter((l: string) => l.includes("Sketch uses") || l.includes("Global variables"));
          return "✅ Compiled: " + project + " (" + fqbn + ")\n" + sizeLines.join("\n");
        } catch (err: any) {
          const errClean = ((err.stdout || "") + "\n" + (err.stderr || "")).replace(/\x1b\[[0-9;]*m/g, "");
          const errLines = errClean.split("\n").filter((l: string) => l.includes("error:") || l.includes("Error during"));
          return "❌ Compile failed:\n" + errLines.join("\n");
        }
      }

      case "arduino_upload": {
        let project = ((args.project || args.path || args.name || "") as string).trim();
        if (project.startsWith("~")) project = project.replace("~", os.homedir());
        const port = args.port as string;
        let projDir = "";
        if (project.startsWith("/") && fs.existsSync(project)) {
          projDir = project;
        } else {
          const name = project.includes("/") ? project.split("/").filter(Boolean).pop() || project : project;
          projDir = path.join(PROJECT_DIR, name);
          if (!fs.existsSync(projDir)) projDir = path.join(USER_ARDUINO, name);
        }

        let fqbn = "";
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(projDir, "project.json"), "utf-8"));
          const brd = BOARDS[meta.board]; fqbn = brd ? brd.fqbn : "";
        } catch {}
        if (args.board) { const brd = BOARDS[resolveBoard(args.board as string)]; if (brd) fqbn = brd.fqbn; }
        if (!fqbn) fqbn = "esp32:esp32:esp32";

        try {
          const { stdout, stderr } = await execAsync(
            `arduino-cli upload --fqbn "${fqbn}" --port "${port}" --libraries "${USER_LIBS}" "${projDir}" 2>&1`,
            { timeout: 120000 }
          );
          return "✅ Uploaded: " + project + " → " + port + "\n" + (stdout + stderr).slice(-300);
        } catch (err: any) {
          return "❌ Upload failed: " + err.message.slice(0, 300);
        }
      }

      case "arduino_install_lib": {
        const library = (args.library as string).trim();
        const local = findLocalLib(library);
        if (local.found) {
          return "✅ Already installed: ~/Arduino/libraries/" + local.name +
            "\nHeaders: " + (local.headers.length > 0 ? local.headers.join(", ") : "check src/ folder") +
            "\nUse: " + local.include;
        }
        try {
          const { stdout } = await execAsync(`arduino-cli lib install "${library}"`, { timeout: 60000 });
          return "✅ Installed: " + library + "\n" + stdout;
        } catch (err: any) {
          try {
            const { stdout } = await execAsync(`arduino-cli lib search "${library}" 2>&1 | head -20`, { timeout: 15000 });
            return "❌ \"" + library + "\" not found. Did you mean:\n" + stdout;
          } catch {
            return "❌ Not found locally or online: " + library;
          }
        }
      }

      case "arduino_list_boards": {
        return Object.entries(BOARDS).map(([key, b]) => {
          const pins = Object.entries(b.pins).map(([n, p]) => n + "=" + p).join(", ");
          return "• " + key + " — " + b.name + "\n  FQBN: " + b.fqbn + "\n  WiFi: " + (b.wifi || "none") + " | Pins: " + pins;
        }).join("\n\n");
      }

      case "arduino_list_projects": {
        ensureDir(PROJECT_DIR);
        const kateDirs = fs.readdirSync(PROJECT_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        const userCount = fs.existsSync(USER_ARDUINO)
          ? fs.readdirSync(USER_ARDUINO).filter(f => f !== "libraries" && !f.startsWith(".")).length : 0;

        let out = "Kate projects (" + kateDirs.length + "):\n";
        if (kateDirs.length > 0) {
          out += kateDirs.map(d => "  • " + d.name).join("\n");
        } else {
          out += "  (none yet)";
        }
        out += "\n\nUser's Arduino projects: " + userCount + " in ~/Arduino/";
        return out;
      }

      case "arduino_list_libs": {
        if (!fs.existsSync(USER_LIBS)) return "No libraries at " + USER_LIBS;
        const libs = fs.readdirSync(USER_LIBS).filter(d => {
          try { return fs.statSync(path.join(USER_LIBS, d)).isDirectory(); } catch { return false; }
        }).sort();
        return "Libraries (" + libs.length + "):\n" + libs.map(l => "  • " + l).join("\n");
      }

      case "arduino_setup": {
        const boards = (args.boards as string).toLowerCase();
        const cmds: string[] = [];
        if (boards.includes("esp8266")) cmds.push("arduino-cli core install esp8266:esp8266 --additional-urls https://arduino.esp8266.com/stable/package_esp8266com_index.json");
        if (boards.includes("esp32")) cmds.push("arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json");
        if (cmds.length === 0) return "Specify: esp8266, esp32, or both";
        try {
          const results = [];
          for (const cmd of cmds) {
            const { stdout } = await execAsync(cmd, { timeout: 300000 });
            results.push(stdout);
          }
          return "✅ Board cores installed:\n" + results.join("\n");
        } catch (err: any) {
          return "❌ Setup failed: " + err.message.slice(0, 300);
        }
      }

      case "arduino_list_ports": {
        try {
          const { stdout } = await execAsync("arduino-cli board list 2>/dev/null || ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null", { timeout: 10000 });
          return stdout || "No serial ports found";
        } catch { return "No serial ports found"; }
      }

      default: return "Unknown tool: " + toolName;
    }
  },
};

export default arduino;
