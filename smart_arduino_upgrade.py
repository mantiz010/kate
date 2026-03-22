#!/usr/bin/env python3
"""
Kate Smart Arduino Upgrade
1. AUTO-RESEARCH: Before writing code, read #include headers to learn real API
2. SURGICAL FIX: On compile error, fix ONLY the broken line — never rewrite entire file
"""
import re, os

ARDUINO_TS = os.path.expanduser("~/kate/src/skills/arduino.ts")

f = open(ARDUINO_TS).read()

# ============================================================
# FEATURE 1: AUTO-RESEARCH
# Adds a function that reads header files for any libraries
# and returns a summary of classes, methods, and patterns.
# This gets injected into the compile output so the model
# sees real API info before rewriting.
# ============================================================

AUTO_RESEARCH_FN = '''
// === AUTO-RESEARCH: Read headers before compile to learn real API ===
function autoResearchHeaders(projDir: string): string {
  const USER_LIBS = path.join(os.homedir(), "Arduino/libraries");
  const CORE_LIBS = path.join(os.homedir(), ".arduino15/packages/esp32/hardware/esp32");
  const facts: string[] = [];
  
  // Find .ino files and extract #include lines
  const inoFiles = fs.readdirSync(projDir).filter((f: string) => f.endsWith(".ino"));
  const allIncludes: string[] = [];
  for (const file of inoFiles) {
    const code = fs.readFileSync(path.join(projDir, file), "utf-8");
    const incs = [...code.matchAll(/#include\\s*[<"]([^>"]+\\.h)[>"]/g)].map(m => m[1]);
    allIncludes.push(...incs);
  }
  
  const unique = [...new Set(allIncludes)];
  
  for (const hName of unique) {
    // Skip standard headers
    if (["Arduino.h", "Wire.h", "SPI.h", "WiFi.h", "string.h", "stdio.h", "stdlib.h"].includes(hName)) continue;
    
    // Find header in user libs then core libs
    let hPath = "";
    try {
      const { execSync } = require("child_process");
      hPath = execSync(
        `find "${USER_LIBS}" -name "${hName}" -type f 2>/dev/null | head -1`,
        { encoding: "utf-8", timeout: 3000 }
      ).trim();
      if (!hPath) {
        // Search core libs (all versions)
        hPath = execSync(
          `find "${CORE_LIBS}" -name "${hName}" -type f 2>/dev/null | head -1`,
          { encoding: "utf-8", timeout: 3000 }
        ).trim();
      }
    } catch {}
    if (!hPath) continue;
    
    let header = "";
    try { header = fs.readFileSync(hPath, "utf-8"); } catch { continue; }
    
    // Extract class names
    const classes = [...header.matchAll(/^\\s*class\\s+(\\w+)/gm)].map(m => m[1]);
    
    // Extract public methods (simplified)
    const methods: string[] = [];
    for (const cls of classes) {
      // Find void begin or bool begin
      const beginMatch = header.match(/(void|bool|int)\\s+begin\\s*\\(/);
      if (beginMatch) methods.push(`${cls}.begin() returns ${beginMatch[1]}`);
      
      // Find set* methods
      const setters = [...header.matchAll(/(void|bool)\\s+(set\\w+)\\s*\\(/g)].map(m => `${m[2]}()`);
      methods.push(...setters.slice(0, 5));
    }
    
    if (classes.length > 0) {
      facts.push(`[${hName}] classes: ${classes.join(", ")}${methods.length ? " | " + methods.join(", ") : ""}`);
    }
  }
  
  return facts.length > 0 ? "\\n--- LIBRARY API (from actual headers) ---\\n" + facts.join("\\n") + "\\n---" : "";
}
'''

# ============================================================
# FEATURE 2: SURGICAL ERROR FIX
# Instead of telling the model "compile failed" and letting it
# rewrite everything, parse the error, extract the line number
# and error message, and return a targeted fix instruction.
# ============================================================

SURGICAL_FIX_FN = '''
// === SURGICAL FIX: Parse compile errors, return targeted fix instructions ===
function parseSurgicalFix(compileOutput: string, projDir: string): string {
  const errors: {file: string, line: number, msg: string, code: string}[] = [];
  
  // Parse gcc error format: file.ino:LINE:COL: error: message
  const errorLines = compileOutput.split("\\n").filter((l: string) => l.includes("error:"));
  
  for (const errLine of errorLines.slice(0, 3)) { // Max 3 errors
    const match = errLine.match(/([^:]+\\.(ino|c|cpp|h)):(\d+):\d+:\s*error:\s*(.+)/);
    if (!match) continue;
    
    const [, file, , lineStr, msg] = match;
    const lineNum = parseInt(lineStr);
    
    // Read the actual source line
    let codeLine = "";
    try {
      const basename = path.basename(file);
      const fullPath = path.join(projDir, basename);
      if (fs.existsSync(fullPath)) {
        const lines = fs.readFileSync(fullPath, "utf-8").split("\\n");
        if (lineNum > 0 && lineNum <= lines.length) {
          codeLine = lines[lineNum - 1].trim();
        }
      }
    } catch {}
    
    errors.push({ file: path.basename(file), line: lineNum, msg: msg.trim(), code: codeLine });
  }
  
  if (errors.length === 0) return "";
  
  // Build surgical fix instructions
  let fix = "\\n--- SURGICAL FIX NEEDED (do NOT rewrite entire file) ---\\n";
  
  for (const err of errors) {
    fix += `ERROR at ${err.file}:${err.line}: ${err.msg}\\n`;
    if (err.code) fix += `  CODE: ${err.code}\\n`;
    
    // Auto-detect common fixes
    if (err.msg.includes("No such file or directory") && err.code.includes("Zigbee")) {
      fix += `  FIX: Replace individual Zigbee header with #include "Zigbee.h" (single header includes all classes)\\n`;
    }
    if (err.msg.includes("does not name a type")) {
      const typeMatch = err.msg.match(/'(\\w+)'/);
      if (typeMatch) {
        fix += `  FIX: Class '${typeMatch[1]}' not found. Check correct class name by reading the actual header file.\\n`;
      }
    }
    if (err.msg.includes("has no member named")) {
      const memberMatch = err.msg.match(/named '(\\w+)'/);
      if (memberMatch) {
        fix += `  FIX: Method '${memberMatch[1]}' does not exist. Read the header to find the correct method name. Do NOT guess.\\n`;
      }
    }
    if (err.msg.includes("void value not ignored")) {
      fix += `  FIX: Function returns void but code checks its return. Remove the if() check and just call the function directly.\\n`;
    }
    if (err.msg.includes("not selected in Tools")) {
      fix += `  FIX: Wrong board. Use board esp32c6-zigbee for Zigbee end devices (adds ZigbeeMode=ed to fqbn).\\n`;
    }
    
    fix += "\\n";
  }
  
  fix += "INSTRUCTIONS: Fix ONLY the lines above. Do NOT rewrite the entire file. Use write_file to replace just the broken lines.\\n---";
  
  return fix;
}
'''

# ============================================================
# INJECT INTO ARDUINO.TS
# ============================================================

# 1. Add both functions before the Boards section
boards_marker = "// ── Boards"
if "autoResearchHeaders" not in f:
    if boards_marker in f:
        f = f.replace(boards_marker, AUTO_RESEARCH_FN + "\n" + SURGICAL_FIX_FN + "\n" + boards_marker)
        print("✅ Added autoResearchHeaders and parseSurgicalFix functions")
    else:
        print("❌ Could not find boards marker")
else:
    print("⏭ autoResearchHeaders already exists")

# 2. Hook autoResearchHeaders into compile output
# Find where compile result is returned and add header research info
if "autoResearchHeaders" in f and "headerInfo" not in f:
    # Find the compile success/fail return and add research
    # Look for the pattern where compile result is assembled
    compile_pattern = 'preCompileFix(projDir);'
    if compile_pattern in f:
        f = f.replace(
            compile_pattern,
            compile_pattern + '\n        const headerInfo = autoResearchHeaders(projDir);'
        )
        print("✅ Hooked autoResearchHeaders before compile")
    else:
        print("⚠ preCompileFix not found, trying alternate hook")
        # Try to find where compile starts
        alt = 'const cmd = `arduino-cli compile'
        if alt in f:
            f = f.replace(alt, 'const headerInfo = autoResearchHeaders(projDir);\n        ' + alt)
            print("✅ Hooked autoResearchHeaders (alternate)")

# 3. Hook parseSurgicalFix into compile error output
if "parseSurgicalFix" in f and "surgicalFix" not in f:
    # Find where compile error is returned
    # Look for pattern like: return "❌ Compile failed:\n" + stderr
    error_patterns = [
        ('return `❌ Compile failed:\\n${stderr', 'const surgicalFix = parseSurgicalFix(stderr, projDir);\n          return `❌ Compile failed:\\n${stderr'),
        ('return "❌ Compile failed:\\n" + stderr', 'const surgicalFix = parseSurgicalFix(stderr, projDir);\n          return "❌ Compile failed:\\n" + stderr'),
    ]
    
    found = False
    for old, new in error_patterns:
        if old in f:
            # Also append surgical fix and header info to the error output
            f = f.replace(old, new)
            found = True
            break
    
    if not found:
        # Try regex approach - find any line that returns compile failed
        match = re.search(r'return\s+[`"]❌\s*Compile\s*failed', f)
        if match:
            pos = match.start()
            f = f[:pos] + 'const surgicalFix = parseSurgicalFix(stderr || stdout || "", projDir);\n          ' + f[pos:]
            found = True
    
    if found:
        print("✅ Hooked parseSurgicalFix into compile error output")
        
        # Now append surgicalFix + headerInfo to the return value
        # Find the error return and append our info
        # Look for the closing of the error return
        if "surgicalFix" in f:
            # Add surgicalFix and headerInfo to error output
            error_return = re.search(r'(return\s+[`"]❌\s*Compile\s*failed[^;]+)(;)', f)
            if error_return:
                original = error_return.group(0)
                # Append surgical fix
                replacement = original.rstrip(';') + ' + (surgicalFix || "") + (headerInfo || "");'
                f = f.replace(original, replacement, 1)
                print("✅ Appended surgicalFix + headerInfo to error output")
    else:
        print("⚠ Could not find compile error return pattern")

# 4. Also append headerInfo to SUCCESS output so model learns for next time
if "headerInfo" in f:
    success_patterns = [
        '`✅ Compiled: ${project}',
        '"✅ Compiled: " + project',
    ]
    for pat in success_patterns:
        if pat in f and "headerInfo" not in f[f.index(pat):f.index(pat)+200]:
            # Don't modify success output - it's fine as is
            pass

# Write back
open(ARDUINO_TS, "w").write(f)

# Verify TypeScript compiles
import subprocess
r = subprocess.run(
    ["node", "-e", "require('esbuild').transformSync(require('fs').readFileSync('src/skills/arduino.ts','utf-8'),{loader:'ts'})"],
    capture_output=True, text=True, timeout=10, cwd=os.path.expanduser("~/kate")
)
if r.returncode == 0:
    print("✅ arduino.ts TypeScript compiles OK")
else:
    print("❌ TypeScript error:", r.stderr[:200])
    
print("\n=== Summary ===")
print("1. autoResearchHeaders: reads #include headers, extracts class names and methods")
print("2. parseSurgicalFix: parses gcc errors, gives targeted fix instructions")
print("3. Both inject into compile output so model sees real API + specific fix guidance")
