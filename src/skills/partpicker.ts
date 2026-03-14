import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const PARTS_DB = path.join(os.homedir(), ".aegis", "parts-db.json");

interface Part {
  name: string;
  value?: string;
  package?: string;
  category: string;
  manufacturer?: string;
  lcsc?: string;
  mouser?: string;
  digikey?: string;
  price?: number;
  stock?: number;
  datasheet?: string;
  notes?: string;
}

let partsDb: Part[] = [];
function loadParts() { try { if (fs.existsSync(PARTS_DB)) partsDb = JSON.parse(fs.readFileSync(PARTS_DB, "utf-8")); } catch {} }
function saveParts() { const d = path.dirname(PARTS_DB); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(PARTS_DB, JSON.stringify(partsDb, null, 2)); }

async function searchLCSC(query: string, count: number): Promise<any[]> {
  try {
    const encoded = encodeURIComponent(query);
    const { stdout } = await execAsync(
      "curl -s -m 10 -H \"User-Agent: Aegis\" \"https://wmsc.lcsc.com/ftps/wm/product/search?keyword=" + encoded + "&limit=" + count + "\"",
      { timeout: 12000 },
    );
    const data = JSON.parse(stdout);
    if (data.result && data.result.tipProductDetailUrlVO) {
      return data.result.tipProductDetailUrlVO.map((p: any) => ({
        name: p.productModel || p.productDescription || "?",
        lcsc: p.productCode || "",
        manufacturer: p.brandNameEn || "",
        package: p.encapStandard || "",
        price: p.productPriceList?.[0]?.productPrice || 0,
        stock: p.stockNumber || 0,
        url: "https://www.lcsc.com/product-detail/" + (p.productCode || "") + ".html",
        datasheet: p.pdfUrl || "",
      }));
    }
    if (data.result && data.result.productList) {
      return data.result.productList.map((p: any) => ({
        name: p.productModel || p.productDescription || "?",
        lcsc: p.productCode || "",
        manufacturer: p.brandNameEn || "",
        package: p.encapStandard || "",
        price: p.productPriceList?.[0]?.productPrice || 0,
        stock: p.stockNumber || 0,
        url: "https://www.lcsc.com/product-detail/" + (p.productCode || "") + ".html",
        datasheet: p.pdfUrl || "",
      }));
    }
  } catch {}
  return [];
}

async function searchOctopart(query: string, count: number): Promise<any[]> {
  try {
    const encoded = encodeURIComponent(query);
    const { stdout } = await execAsync(
      "curl -s -m 10 \"https://octopart.com/api/v4/search?q=" + encoded + "&limit=" + count + "\" -H \"User-Agent: Aegis\"",
      { timeout: 12000 },
    );
    const data = JSON.parse(stdout);
    if (data.results) {
      return data.results.map((r: any) => ({
        name: r.item?.mpn || "?",
        manufacturer: r.item?.manufacturer?.name || "",
        description: r.snippet || "",
        url: "https://octopart.com" + (r.item?.slug || ""),
        datasheet: r.item?.datasheets?.[0]?.url || "",
      }));
    }
  } catch {}
  return [];
}

// Common parts library
const COMMON_PARTS: Record<string, Part[]> = {
  "esp32": [
    { name: "ESP32-WROOM-32E", category: "MCU", manufacturer: "Espressif", package: "Module", lcsc: "C82899", price: 2.50, notes: "WiFi+BT, 4MB flash" },
    { name: "ESP32-S3-WROOM-1", category: "MCU", manufacturer: "Espressif", package: "Module", lcsc: "C2913202", price: 3.20, notes: "WiFi+BT5, USB-OTG" },
    { name: "ESP32-C3-MINI-1", category: "MCU", manufacturer: "Espressif", package: "Module", lcsc: "C2838502", price: 1.80, notes: "WiFi+BLE5, RISC-V" },
    { name: "ESP32-C6-MINI-1", category: "MCU", manufacturer: "Espressif", package: "Module", lcsc: "C5361865", price: 2.10, notes: "WiFi6+BLE5+Zigbee+Thread" },
    { name: "ESP32-H2-MINI-1", category: "MCU", manufacturer: "Espressif", package: "Module", lcsc: "C5365853", price: 1.90, notes: "BLE5+Zigbee+Thread, no WiFi" },
  ],
  "resistor": [
    { name: "10K 0402", category: "Resistor", package: "0402", lcsc: "C25744", price: 0.002, notes: "1% thick film" },
    { name: "10K 0603", category: "Resistor", package: "0603", lcsc: "C25804", price: 0.002, notes: "1% thick film" },
    { name: "4.7K 0603", category: "Resistor", package: "0603", lcsc: "C25890", price: 0.002, notes: "I2C pullup" },
    { name: "1K 0603", category: "Resistor", package: "0603", lcsc: "C21190", price: 0.002, notes: "LED current limit" },
    { name: "100R 0603", category: "Resistor", package: "0603", lcsc: "C22775", price: 0.002, notes: "General" },
  ],
  "capacitor": [
    { name: "100nF 0402", category: "Capacitor", package: "0402", lcsc: "C1525", price: 0.003, notes: "Decoupling" },
    { name: "100nF 0603", category: "Capacitor", package: "0603", lcsc: "C14663", price: 0.003, notes: "Decoupling" },
    { name: "10uF 0805", category: "Capacitor", package: "0805", lcsc: "C19702", price: 0.01, notes: "Bulk bypass" },
    { name: "1uF 0603", category: "Capacitor", package: "0603", lcsc: "C15849", price: 0.005, notes: "General" },
    { name: "22pF 0402", category: "Capacitor", package: "0402", lcsc: "C1555", price: 0.003, notes: "Crystal load" },
  ],
  "sensor": [
    { name: "BME280", category: "Sensor", manufacturer: "Bosch", package: "LGA-8", lcsc: "C92489", price: 3.50, notes: "Temp+humid+pressure" },
    { name: "SHT40", category: "Sensor", manufacturer: "Sensirion", package: "DFN-4", lcsc: "C2932880", price: 2.00, notes: "Temp+humid, I2C" },
    { name: "BH1750", category: "Sensor", manufacturer: "ROHM", package: "WSOF6I", lcsc: "C78960", price: 1.20, notes: "Light sensor, I2C" },
    { name: "MPU6050", category: "Sensor", manufacturer: "TDK", package: "QFN-24", lcsc: "C24112", price: 2.80, notes: "Accel+gyro, I2C" },
    { name: "VEML7700", category: "Sensor", manufacturer: "Vishay", package: "OPGP-4", lcsc: "C126689", price: 1.50, notes: "Ambient light, I2C" },
  ],
  "connector": [
    { name: "USB-C 16P", category: "Connector", package: "SMD", lcsc: "C168688", price: 0.30, notes: "USB 2.0 receptacle" },
    { name: "JST-PH 2P", category: "Connector", package: "THT", lcsc: "C131337", price: 0.05, notes: "Battery connector" },
    { name: "Pin Header 2.54mm 1x10", category: "Connector", package: "THT", lcsc: "C2337", price: 0.10, notes: "Standard header" },
    { name: "SMA Edge", category: "Connector", package: "SMD", lcsc: "C496550", price: 0.80, notes: "Antenna connector" },
  ],
  "regulator": [
    { name: "AMS1117-3.3", category: "Regulator", manufacturer: "AMS", package: "SOT-223", lcsc: "C6186", price: 0.15, notes: "3.3V 1A LDO" },
    { name: "ME6211C33", category: "Regulator", manufacturer: "Microne", package: "SOT-23-5", lcsc: "C82942", price: 0.10, notes: "3.3V 500mA low quiescent" },
    { name: "AP2112K-3.3", category: "Regulator", manufacturer: "Diodes Inc", package: "SOT-23-5", lcsc: "C51118", price: 0.15, notes: "3.3V 600mA LDO" },
  ],
  "led": [
    { name: "WS2812B", category: "LED", manufacturer: "Worldsemi", package: "5050", lcsc: "C114586", price: 0.08, notes: "Addressable RGB" },
    { name: "Green 0603", category: "LED", package: "0603", lcsc: "C72043", price: 0.02, notes: "Status LED" },
    { name: "Red 0603", category: "LED", package: "0603", lcsc: "C2286", price: 0.02, notes: "Error LED" },
    { name: "Blue 0603", category: "LED", package: "0603", lcsc: "C72041", price: 0.02, notes: "Power LED" },
  ],
};

const partpicker: Skill = {
  id: "builtin.partpicker",
  name: "Part Picker",
  description: "Search for electronic components, compare prices, check LCSC/Mouser stock, build BOMs with costs, maintain a parts library.",
  version: "1.0.0",
  tools: [
    { name: "part_search", description: "Search for electronic components by name, value, or category", parameters: [
      { name: "query", type: "string", description: "Search: part name, value, or category (esp32, 10k resistor, bme280, usb-c)", required: true },
      { name: "count", type: "number", description: "Max results (default: 10)", required: false },
    ]},
    { name: "part_search_online", description: "Search LCSC for components with live pricing and stock", parameters: [
      { name: "query", type: "string", description: "Part number or description", required: true },
      { name: "count", type: "number", description: "Max results (default: 5)", required: false },
    ]},
    { name: "part_common", description: "List common parts by category: esp32, resistor, capacitor, sensor, connector, regulator, led", parameters: [
      { name: "category", type: "string", description: "Category name", required: true },
    ]},
    { name: "part_bom_cost", description: "Calculate total BOM cost from a parts list", parameters: [
      { name: "parts", type: "string", description: "JSON array [{name, qty, lcsc?}] or comma-separated: '10K 0603 x10, ESP32-C6 x1, BME280 x1'", required: true },
    ]},
    { name: "part_save", description: "Save a part to your personal library", parameters: [
      { name: "name", type: "string", description: "Part name/number", required: true },
      { name: "category", type: "string", description: "Category", required: true },
      { name: "lcsc", type: "string", description: "LCSC part number", required: false },
      { name: "package", type: "string", description: "Package type", required: false },
      { name: "price", type: "number", description: "Unit price", required: false },
      { name: "notes", type: "string", description: "Notes", required: false },
    ]},
    { name: "part_library", description: "List your saved parts", parameters: [
      { name: "category", type: "string", description: "Filter by category", required: false },
    ]},
    { name: "part_datasheet", description: "Find and fetch a datasheet for a component", parameters: [
      { name: "part", type: "string", description: "Part name or number", required: true },
    ]},
    { name: "part_alternatives", description: "Find alternative/equivalent parts", parameters: [
      { name: "part", type: "string", description: "Part to find alternatives for", required: true },
    ]},
    { name: "part_for_project", description: "Suggest all parts needed for a project type", parameters: [
      { name: "project", type: "string", description: "Project: esp32-sensor, esp32-relay, esp32-zigbee, led-strip, motor-driver", required: true },
    ]},
  ],

  async onLoad() { loadParts(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    loadParts();

    switch (toolName) {
      case "part_search": {
        const q = (args.query as string).toLowerCase();
        const count = (args.count as number) || 10;
        const results: Part[] = [];

        // Search common parts
        for (const [cat, parts] of Object.entries(COMMON_PARTS)) {
          for (const p of parts) {
            if (p.name.toLowerCase().includes(q) || cat.includes(q) || (p.notes || "").toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q)) {
              results.push(p);
            }
          }
        }

        // Search personal library
        for (const p of partsDb) {
          if (p.name.toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q) || (p.notes || "").toLowerCase().includes(q)) {
            results.push(p);
          }
        }

        if (results.length === 0) return "No parts found for: " + q + ". Try: part_search_online for live search.";

        return results.slice(0, count).map((p, i) =>
          (i + 1) + ". " + p.name +
          (p.package ? " [" + p.package + "]" : "") +
          (p.manufacturer ? " — " + p.manufacturer : "") +
          "\n   " + (p.category || "?") +
          (p.lcsc ? " | LCSC: " + p.lcsc : "") +
          (p.price ? " | $" + p.price.toFixed(3) : "") +
          (p.notes ? "\n   " + p.notes : "")
        ).join("\n\n");
      }

      case "part_search_online": {
        const count = (args.count as number) || 5;
        const results = await searchLCSC(args.query as string, count);
        if (results.length === 0) return "No online results for: " + args.query;
        return "LCSC Results:\n\n" + results.map((r, i) =>
          (i + 1) + ". " + r.name +
          (r.package ? " [" + r.package + "]" : "") +
          (r.manufacturer ? " — " + r.manufacturer : "") +
          "\n   LCSC: " + r.lcsc +
          " | Price: $" + (r.price || "?") +
          " | Stock: " + (r.stock || "?") +
          "\n   " + r.url +
          (r.datasheet ? "\n   Datasheet: " + r.datasheet : "")
        ).join("\n\n");
      }

      case "part_common": {
        const cat = (args.category as string).toLowerCase();
        const parts = COMMON_PARTS[cat];
        if (!parts) return "Unknown category. Available: " + Object.keys(COMMON_PARTS).join(", ");
        return cat.toUpperCase() + " Parts:\n\n" + parts.map((p, i) =>
          (i + 1) + ". " + p.name +
          (p.package ? " [" + p.package + "]" : "") +
          (p.manufacturer ? " — " + p.manufacturer : "") +
          "\n   LCSC: " + (p.lcsc || "?") +
          " | ~$" + (p.price || "?") +
          (p.notes ? " | " + p.notes : "")
        ).join("\n\n");
      }

      case "part_bom_cost": {
        const raw = args.parts as string;
        let items: Array<{ name: string; qty: number; price?: number }> = [];

        try {
          items = JSON.parse(raw);
        } catch {
          // Parse comma format: "10K 0603 x10, ESP32-C6 x1"
          items = raw.split(",").map(s => {
            const m = s.trim().match(/(.+?)\s*x\s*(\d+)/i);
            if (m) return { name: m[1].trim(), qty: parseInt(m[2]) };
            return { name: s.trim(), qty: 1 };
          });
        }

        let total = 0;
        const lines: string[] = ["BOM Cost Estimate:", "", "Part | Qty | Unit | Line Total", "---|---|---|---"];

        for (const item of items) {
          // Find price from common parts
          let price = item.price || 0;
          if (!price) {
            for (const parts of Object.values(COMMON_PARTS)) {
              const found = parts.find(p => p.name.toLowerCase().includes(item.name.toLowerCase()));
              if (found && found.price) { price = found.price; break; }
            }
          }
          const lineTotal = price * item.qty;
          total += lineTotal;
          lines.push(item.name + " | " + item.qty + " | $" + price.toFixed(3) + " | $" + lineTotal.toFixed(3));
        }

        lines.push("---|---|---|---");
        lines.push("**TOTAL** | " + items.reduce((a, i) => a + i.qty, 0) + " parts | | **$" + total.toFixed(2) + "**");
        lines.push("");
        lines.push("Note: Prices are estimates from LCSC. Add ~$5-15 for PCB fabrication (JLCPCB 5pcs).");

        return lines.join("\n");
      }

      case "part_save": {
        const part: Part = {
          name: args.name as string,
          category: args.category as string,
          lcsc: args.lcsc as string,
          package: args.package as string,
          price: args.price as number,
          notes: args.notes as string,
        };
        partsDb = partsDb.filter(p => p.name !== part.name);
        partsDb.push(part);
        saveParts();
        return "Saved: " + part.name + " (" + part.category + ")";
      }

      case "part_library": {
        if (partsDb.length === 0) return "No saved parts. Use part_save to add.";
        let filtered = partsDb;
        if (args.category) filtered = partsDb.filter(p => p.category.toLowerCase().includes((args.category as string).toLowerCase()));
        return "Your Parts (" + filtered.length + "):\n\n" + filtered.map(p =>
          "  " + p.name + " [" + (p.package || "?") + "] — " + p.category +
          (p.lcsc ? " | LCSC: " + p.lcsc : "") +
          (p.price ? " | $" + p.price : "") +
          (p.notes ? "\n    " + p.notes : "")
        ).join("\n");
      }

      case "part_datasheet": {
        const query = args.part as string;
        // Search GitHub for datasheets
        try {
          const encoded = encodeURIComponent(query + " datasheet");
          const { stdout } = await execAsync(
            "curl -s -m 10 -H \"User-Agent: Aegis\" \"https://api.github.com/search/code?q=" + encoded + "+extension:pdf&per_page=3\"",
            { timeout: 12000 },
          );
          const data = JSON.parse(stdout);
          if (data.items && data.items.length > 0) {
            return "Datasheets found:\n\n" + data.items.map((r: any) =>
              "  " + r.name + "\n  " + r.html_url
            ).join("\n\n");
          }
        } catch {}

        // Fallback: search for manufacturer page
        return "Search for datasheet: https://www.google.com/search?q=" + encodeURIComponent(query + " datasheet pdf") + "\nOr check: https://www.lcsc.com/search?q=" + encodeURIComponent(query);
      }

      case "part_alternatives": {
        const q = (args.part as string).toLowerCase();
        const alts: Record<string, string[]> = {
          "esp32-wroom": ["ESP32-S3-WROOM-1 (better, USB-OTG)", "ESP32-C3-MINI-1 (cheaper, RISC-V)", "ESP32-C6-MINI-1 (Zigbee+Thread)"],
          "bme280": ["SHT40 (cheaper, temp+humid only)", "BME680 (adds gas sensor)", "SHTC3 (low power)"],
          "ams1117": ["ME6211 (lower quiescent)", "AP2112K (better PSRR)", "RT9013 (ultra low noise)"],
          "ws2812b": ["SK6812 (RGBW)", "WS2812E (improved)", "APA102 (faster, SPI)"],
          "mpu6050": ["LSM6DS3 (lower power)", "ICM-42688 (better accuracy)", "BMI270 (wearable grade)"],
        };

        for (const [key, vals] of Object.entries(alts)) {
          if (q.includes(key) || key.includes(q)) {
            return "Alternatives for " + args.part + ":\n\n" + vals.map((v, i) => "  " + (i + 1) + ". " + v).join("\n");
          }
        }

        return "No known alternatives for: " + args.part + ". Try part_search_online for similar parts.";
      }

      case "part_for_project": {
        const proj = (args.project as string).toLowerCase();
        const kits: Record<string, Array<{ part: string; qty: number; notes: string }>> = {
          "esp32-sensor": [
            { part: "ESP32-C3-MINI-1", qty: 1, notes: "WiFi+BLE MCU" },
            { part: "BME280", qty: 1, notes: "Temp/humid/pressure" },
            { part: "AMS1117-3.3", qty: 1, notes: "3.3V regulator" },
            { part: "USB-C 16P", qty: 1, notes: "Power + programming" },
            { part: "100nF 0603", qty: 4, notes: "Decoupling caps" },
            { part: "10uF 0805", qty: 2, notes: "Bulk bypass" },
            { part: "10K 0603", qty: 2, notes: "I2C pullups" },
            { part: "Green 0603", qty: 1, notes: "Status LED" },
            { part: "1K 0603", qty: 1, notes: "LED resistor" },
          ],
          "esp32-zigbee": [
            { part: "ESP32-C6-MINI-1", qty: 1, notes: "WiFi6+Zigbee+Thread" },
            { part: "SHT40", qty: 1, notes: "Temp/humidity sensor" },
            { part: "ME6211C33", qty: 1, notes: "3.3V low-power LDO" },
            { part: "USB-C 16P", qty: 1, notes: "Power + programming" },
            { part: "100nF 0402", qty: 4, notes: "Decoupling" },
            { part: "10uF 0805", qty: 2, notes: "Bulk caps" },
            { part: "4.7K 0603", qty: 2, notes: "I2C pullups" },
            { part: "2.4GHz PCB Antenna", qty: 1, notes: "Zigbee antenna" },
            { part: "Blue 0603", qty: 1, notes: "Status LED" },
          ],
          "esp32-relay": [
            { part: "ESP32-WROOM-32E", qty: 1, notes: "WiFi+BT MCU" },
            { part: "SRD-05VDC-SL-C", qty: 4, notes: "5V relay" },
            { part: "BC547", qty: 4, notes: "Relay driver transistor" },
            { part: "1N4007", qty: 4, notes: "Flyback diode" },
            { part: "1K 0603", qty: 4, notes: "Base resistor" },
            { part: "AMS1117-3.3", qty: 1, notes: "3.3V regulator" },
            { part: "USB-C 16P", qty: 1, notes: "Power" },
            { part: "100nF 0603", qty: 4, notes: "Decoupling" },
            { part: "Screw Terminal 2P", qty: 4, notes: "Relay outputs" },
          ],
          "led-strip": [
            { part: "ESP32-WROOM-32E", qty: 1, notes: "WiFi controller" },
            { part: "WS2812B", qty: 60, notes: "60 LEDs/meter strip" },
            { part: "SN74HCT245", qty: 1, notes: "Level shifter 3.3→5V" },
            { part: "1000uF 16V", qty: 1, notes: "Power smoothing" },
            { part: "470R", qty: 1, notes: "Data line resistor" },
            { part: "USB-C 16P", qty: 1, notes: "Programming" },
            { part: "DC Barrel 5.5x2.1", qty: 1, notes: "5V power in" },
          ],
        };

        const kit = kits[proj];
        if (!kit) return "Unknown project. Available: " + Object.keys(kits).join(", ");

        let total = 0;
        const lines = ["Parts for: " + proj, "", "Part | Qty | Notes | Est. Cost", "---|---|---|---"];
        for (const item of kit) {
          let price = 0;
          for (const parts of Object.values(COMMON_PARTS)) {
            const found = parts.find(p => p.name === item.part);
            if (found?.price) { price = found.price; break; }
          }
          const cost = price * item.qty;
          total += cost;
          lines.push(item.part + " | " + item.qty + " | " + item.notes + " | $" + (cost > 0 ? cost.toFixed(2) : "?"));
        }
        lines.push("---|---|---|---");
        lines.push("**TOTAL** | " + kit.reduce((a, i) => a + i.qty, 0) + " | | **~$" + total.toFixed(2) + "**");
        lines.push("");
        lines.push("+ PCB fab: ~$5-15 (JLCPCB 5pcs)");
        lines.push("+ Shipping: ~$3-8 (LCSC standard)");

        return lines.join("\n");
      }

      default: return "Unknown: " + toolName;
    }
  },
};

export default partpicker;
