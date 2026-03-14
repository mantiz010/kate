import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT_DIR = path.join(os.homedir(), ".aegis", "pcb-projects");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── KiCad file generators ──────────────────────────────────────

function generateKicadProject(name: string): string {
  return JSON.stringify({
    meta: { filename: `${name}.kicad_pro`, version: 1 },
    board: { design_settings: { defaults: { board_outline_line_width: 0.15 } } },
    schematic: { drawing: { default_line_thickness: 0.006 } },
  }, null, 2);
}

interface SchematicComponent {
  ref: string;
  value: string;
  lib: string;
  symbol: string;
  x: number;
  y: number;
  pins?: { name: string; number: string; type: string }[];
}

interface SchematicWire {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

interface SchematicNet {
  name: string;
  label: { x: number; y: number };
}

function generateKicadSchematic(
  components: SchematicComponent[],
  wires: SchematicWire[],
  nets: SchematicNet[],
  title: string,
): string {
  let sch = `(kicad_sch (version 20230121) (generator "kate-pcb")
  (paper "A4")
  (title_block (title "${title}") (date "${new Date().toISOString().slice(0, 10)}"))
`;

  // Add symbols
  for (const comp of components) {
    sch += `
  (symbol (lib_id "${comp.lib}:${comp.symbol}") (at ${comp.x} ${comp.y} 0)
    (uuid "${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}")
    (property "Reference" "${comp.ref}" (at ${comp.x} ${comp.y - 3} 0))
    (property "Value" "${comp.value}" (at ${comp.x} ${comp.y + 3} 0))
  )
`;
  }

  // Add wires
  for (const wire of wires) {
    sch += `  (wire (pts (xy ${wire.from.x} ${wire.from.y}) (xy ${wire.to.x} ${wire.to.y})))\n`;
  }

  // Add net labels
  for (const net of nets) {
    sch += `  (label "${net.name}" (at ${net.label.x} ${net.label.y} 0))\n`;
  }

  sch += ")\n";
  return sch;
}

function generateNetlist(components: SchematicComponent[], nets: { name: string; pins: string[] }[]): string {
  let nl = `(export (version "E")
  (design (source "kate-generated") (date "${new Date().toISOString()}"))
  (components\n`;

  for (const comp of components) {
    nl += `    (comp (ref "${comp.ref}") (value "${comp.value}") (footprint "") (libsource (lib "${comp.lib}") (part "${comp.symbol}")))\n`;
  }
  nl += "  )\n  (nets\n";

  for (let i = 0; i < nets.length; i++) {
    nl += `    (net (code "${i + 1}") (name "${nets[i].name}")\n`;
    for (const pin of nets[i].pins) {
      nl += `      (node (ref "${pin.split(".")[0]}") (pin "${pin.split(".")[1]}"))\n`;
    }
    nl += "    )\n";
  }

  nl += "  )\n)\n";
  return nl;
}

function generateBOM(components: SchematicComponent[]): string {
  const lines = [
    "Reference,Value,Symbol,Quantity",
    ...components.map(c => `${c.ref},${c.value},${c.lib}:${c.symbol},1`),
  ];
  return lines.join("\n");
}

function generateGerberJobFile(name: string): string {
  return JSON.stringify({
    Header: { GenerationSoftware: { Application: "Kate PCB Builder", Version: "1.0" } },
    GeneralSpecs: {
      ProjectId: { Name: name, GUID: Math.random().toString(36).slice(2) },
      Size: { X: 100, Y: 100 },
      BoardThickness: 1.6,
    },
    FilesAttributes: [
      { FileFunction: "Copper,L1,Top", FilePolarity: "Positive" },
      { FileFunction: "Copper,L2,Bot", FilePolarity: "Positive" },
      { FileFunction: "SolderMask,Top", FilePolarity: "Negative" },
      { FileFunction: "SolderMask,Bot", FilePolarity: "Negative" },
      { FileFunction: "Legend,Top", FilePolarity: "Positive" },
      { FileFunction: "Profile", FilePolarity: "Positive" },
    ],
  }, null, 2);
}

// ── Common circuit templates ───────────────────────────────────

const TEMPLATES: Record<string, () => {
  components: SchematicComponent[];
  wires: SchematicWire[];
  nets: SchematicNet[];
  netlist: { name: string; pins: string[] }[];
  description: string;
}> = {
  "esp32-basic": () => ({
    description: "Basic ESP32 circuit with power regulation, programming header, reset/boot buttons",
    components: [
      { ref: "U1", value: "ESP32-WROOM-32", lib: "RF_Module", symbol: "ESP32-WROOM-32", x: 100, y: 80 },
      { ref: "U2", value: "AMS1117-3.3", lib: "Regulator_Linear", symbol: "AMS1117-3.3", x: 40, y: 30 },
      { ref: "C1", value: "10uF", lib: "Device", symbol: "C_Polarized", x: 25, y: 30 },
      { ref: "C2", value: "10uF", lib: "Device", symbol: "C_Polarized", x: 55, y: 30 },
      { ref: "C3", value: "100nF", lib: "Device", symbol: "C", x: 70, y: 50 },
      { ref: "R1", value: "10K", lib: "Device", symbol: "R", x: 60, y: 60 },
      { ref: "R2", value: "10K", lib: "Device", symbol: "R", x: 60, y: 70 },
      { ref: "SW1", value: "RESET", lib: "Switch", symbol: "SW_Push", x: 50, y: 60 },
      { ref: "SW2", value: "BOOT", lib: "Switch", symbol: "SW_Push", x: 50, y: 70 },
      { ref: "J1", value: "USB-C", lib: "Connector", symbol: "USB_C_Receptacle", x: 15, y: 30 },
      { ref: "J2", value: "Header 2x10", lib: "Connector_Generic", symbol: "Conn_02x10_Odd_Even", x: 160, y: 80 },
      { ref: "LED1", value: "LED", lib: "Device", symbol: "LED", x: 140, y: 40 },
      { ref: "R3", value: "330", lib: "Device", symbol: "R", x: 140, y: 50 },
    ],
    wires: [
      { from: { x: 15, y: 30 }, to: { x: 25, y: 30 } },
      { from: { x: 25, y: 30 }, to: { x: 40, y: 30 } },
      { from: { x: 40, y: 30 }, to: { x: 55, y: 30 } },
    ],
    nets: [
      { name: "VCC", label: { x: 15, y: 25 } },
      { name: "3V3", label: { x: 55, y: 25 } },
      { name: "GND", label: { x: 40, y: 40 } },
    ],
    netlist: [
      { name: "VCC", pins: ["J1.1", "C1.1", "U2.3"] },
      { name: "3V3", pins: ["U2.2", "C2.1", "C3.1", "U1.2", "R1.1", "R2.1"] },
      { name: "GND", pins: ["J1.4", "C1.2", "U2.1", "C2.2", "C3.2", "U1.1", "SW1.2", "SW2.2"] },
      { name: "EN", pins: ["U1.3", "R1.2", "SW1.1"] },
      { name: "IO0", pins: ["U1.25", "R2.2", "SW2.1"] },
      { name: "LED_OUT", pins: ["U1.12", "R3.1"] },
    ],
  }),

  "sensor-board": () => ({
    description: "Multi-sensor board with I2C bus, temperature, humidity, and IMU",
    components: [
      { ref: "U1", value: "ESP32-WROOM-32", lib: "RF_Module", symbol: "ESP32-WROOM-32", x: 100, y: 80 },
      { ref: "U2", value: "BME280", lib: "Sensor", symbol: "BME280", x: 160, y: 40 },
      { ref: "U3", value: "MPU6050", lib: "Sensor_Motion", symbol: "MPU-6050", x: 160, y: 80 },
      { ref: "U4", value: "AMS1117-3.3", lib: "Regulator_Linear", symbol: "AMS1117-3.3", x: 40, y: 30 },
      { ref: "R1", value: "4.7K", lib: "Device", symbol: "R", x: 130, y: 35 },
      { ref: "R2", value: "4.7K", lib: "Device", symbol: "R", x: 135, y: 35 },
      { ref: "C1", value: "100nF", lib: "Device", symbol: "C", x: 155, y: 55 },
      { ref: "C2", value: "100nF", lib: "Device", symbol: "C", x: 155, y: 95 },
      { ref: "C3", value: "10uF", lib: "Device", symbol: "C_Polarized", x: 25, y: 30 },
      { ref: "J1", value: "USB-C", lib: "Connector", symbol: "USB_C_Receptacle", x: 15, y: 30 },
    ],
    wires: [
      { from: { x: 130, y: 45 }, to: { x: 160, y: 45 } },
      { from: { x: 135, y: 45 }, to: { x: 160, y: 85 } },
    ],
    nets: [
      { name: "SDA", label: { x: 130, y: 33 } },
      { name: "SCL", label: { x: 135, y: 33 } },
      { name: "3V3", label: { x: 55, y: 25 } },
    ],
    netlist: [
      { name: "SDA", pins: ["U1.21", "U2.1", "U3.1", "R1.1"] },
      { name: "SCL", pins: ["U1.22", "U2.2", "U3.2", "R2.1"] },
      { name: "3V3", pins: ["U4.2", "U1.2", "U2.3", "U3.3", "R1.2", "R2.2"] },
      { name: "GND", pins: ["U4.1", "U1.1", "U2.4", "U3.4", "C1.2", "C2.2", "C3.2", "J1.4"] },
    ],
  }),

  "motor-driver": () => ({
    description: "Dual H-bridge motor driver with ESP32 control, current sensing",
    components: [
      { ref: "U1", value: "ESP32-WROOM-32", lib: "RF_Module", symbol: "ESP32-WROOM-32", x: 80, y: 80 },
      { ref: "U2", value: "L298N", lib: "Driver_Motor", symbol: "L298N", x: 160, y: 60 },
      { ref: "U3", value: "AMS1117-3.3", lib: "Regulator_Linear", symbol: "AMS1117-3.3", x: 40, y: 30 },
      { ref: "D1", value: "1N4007", lib: "Diode", symbol: "D", x: 145, y: 40 },
      { ref: "D2", value: "1N4007", lib: "Diode", symbol: "D", x: 155, y: 40 },
      { ref: "D3", value: "1N4007", lib: "Diode", symbol: "D", x: 165, y: 40 },
      { ref: "D4", value: "1N4007", lib: "Diode", symbol: "D", x: 175, y: 40 },
      { ref: "C1", value: "100nF", lib: "Device", symbol: "C", x: 130, y: 50 },
      { ref: "C2", value: "470uF", lib: "Device", symbol: "C_Polarized", x: 190, y: 50 },
      { ref: "R1", value: "0.5R", lib: "Device", symbol: "R", x: 150, y: 85 },
      { ref: "R2", value: "0.5R", lib: "Device", symbol: "R", x: 170, y: 85 },
      { ref: "J1", value: "Screw_Terminal_2", lib: "Connector", symbol: "Screw_Terminal_01x02", x: 200, y: 55 },
      { ref: "J2", value: "Screw_Terminal_2", lib: "Connector", symbol: "Screw_Terminal_01x02", x: 200, y: 70 },
      { ref: "J3", value: "Barrel_Jack", lib: "Connector", symbol: "Barrel_Jack", x: 15, y: 30 },
    ],
    wires: [],
    nets: [
      { name: "MOTOR_A_PWM", label: { x: 110, y: 55 } },
      { name: "MOTOR_B_PWM", label: { x: 110, y: 65 } },
      { name: "VMOT", label: { x: 190, y: 25 } },
    ],
    netlist: [
      { name: "MOTOR_A_PWM", pins: ["U1.12", "U2.6"] },
      { name: "MOTOR_B_PWM", pins: ["U1.14", "U2.11"] },
      { name: "IN1", pins: ["U1.25", "U2.5"] },
      { name: "IN2", pins: ["U1.26", "U2.7"] },
      { name: "IN3", pins: ["U1.27", "U2.10"] },
      { name: "IN4", pins: ["U1.13", "U2.12"] },
      { name: "VMOT", pins: ["J3.1", "U2.4", "C2.1"] },
    ],
  }),
};

const pcbBuilder: Skill = {
  id: "builtin.pcb",
  name: "PCB Builder",
  description: "Design PCBs: generate KiCad schematics, netlists, BOMs, and Gerber job files. Includes templates for ESP32, sensor boards, and motor drivers.",
  version: "1.0.0",
  tools: [
    {
      name: "pcb_new_project",
      description: "Create a new KiCad PCB project with directory structure",
      parameters: [
        { name: "name", type: "string", description: "Project name", required: true },
        { name: "template", type: "string", description: "Template to use: esp32-basic, sensor-board, motor-driver, or blank", required: false },
        { name: "description", type: "string", description: "Project description", required: false },
      ],
    },
    {
      name: "pcb_add_component",
      description: "Add a component to the current schematic",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
        { name: "ref", type: "string", description: "Reference designator (e.g. R1, C2, U3)", required: true },
        { name: "value", type: "string", description: "Component value (e.g. 10K, 100nF, ESP32)", required: true },
        { name: "library", type: "string", description: "KiCad library (e.g. Device, RF_Module)", required: true },
        { name: "symbol", type: "string", description: "Symbol name (e.g. R, C, ESP32-WROOM-32)", required: true },
        { name: "x", type: "number", description: "X position on schematic", required: false },
        { name: "y", type: "number", description: "Y position on schematic", required: false },
      ],
    },
    {
      name: "pcb_add_net",
      description: "Add a net connection between component pins",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
        { name: "name", type: "string", description: "Net name (e.g. VCC, GND, SDA)", required: true },
        { name: "pins", type: "string", description: "Comma-separated pins (e.g. 'U1.3,R1.1,C1.1')", required: true },
      ],
    },
    {
      name: "pcb_generate",
      description: "Generate all output files for a project: schematic, netlist, BOM, Gerber job",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
      ],
    },
    {
      name: "pcb_list_templates",
      description: "List available PCB project templates",
      parameters: [],
    },
    {
      name: "pcb_list_projects",
      description: "List all PCB projects",
      parameters: [],
    },
    {
      name: "pcb_export_bom",
      description: "Export Bill of Materials for a project",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
        { name: "format", type: "string", description: "Format: csv (default) or json", required: false },
      ],
    },
    {
      name: "pcb_design_review",
      description: "Run a basic design rule check on a project — checks for common issues",
      parameters: [
        { name: "project", type: "string", description: "Project name", required: true },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    ensureDir(PROJECT_DIR);

    switch (toolName) {
      case "pcb_new_project": {
        const name = args.name as string;
        const template = (args.template as string) || "blank";
        const desc = (args.description as string) || "";
        const projDir = path.join(PROJECT_DIR, name);

        ensureDir(projDir);
        ensureDir(path.join(projDir, "gerbers"));
        ensureDir(path.join(projDir, "docs"));

        // Save project file
        fs.writeFileSync(path.join(projDir, `${name}.kicad_pro`), generateKicadProject(name));

        // Save project metadata
        const meta: any = {
          name, description: desc, template, createdAt: Date.now(),
          components: [], wires: [], nets: [], netConnections: [],
        };

        if (template !== "blank" && TEMPLATES[template]) {
          const t = TEMPLATES[template]();
          meta.components = t.components;
          meta.wires = t.wires;
          meta.nets = t.nets;
          meta.netConnections = t.netlist;
          meta.description = desc || t.description;

          // Auto-generate files
          fs.writeFileSync(
            path.join(projDir, `${name}.kicad_sch`),
            generateKicadSchematic(t.components, t.wires, t.nets, name),
          );
          fs.writeFileSync(path.join(projDir, `${name}.net`), generateNetlist(t.components, t.netlist));
          fs.writeFileSync(path.join(projDir, `${name}_bom.csv`), generateBOM(t.components));
        }

        fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify(meta, null, 2));

        const compCount = meta.components.length;
        return [
          `Created project: ${name}`,
          `Template: ${template}`,
          `Location: ${projDir}`,
          `Components: ${compCount}`,
          compCount > 0 ? `Files generated: schematic, netlist, BOM` : "Empty project — add components with pcb_add_component",
        ].join("\n");
      }

      case "pcb_add_component": {
        const project = args.project as string;
        const metaPath = path.join(PROJECT_DIR, project, "project.json");
        if (!fs.existsSync(metaPath)) return `Project not found: ${project}`;

        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const comp: SchematicComponent = {
          ref: args.ref as string,
          value: args.value as string,
          lib: args.library as string,
          symbol: args.symbol as string,
          x: (args.x as number) || 100 + meta.components.length * 30,
          y: (args.y as number) || 80,
        };

        meta.components.push(comp);
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        return `Added ${comp.ref} (${comp.value}) to project "${project}". Total components: ${meta.components.length}`;
      }

      case "pcb_add_net": {
        const project = args.project as string;
        const metaPath = path.join(PROJECT_DIR, project, "project.json");
        if (!fs.existsSync(metaPath)) return `Project not found: ${project}`;

        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const netName = args.name as string;
        const pins = (args.pins as string).split(",").map(s => s.trim());

        meta.netConnections.push({ name: netName, pins });
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        return `Added net "${netName}" connecting: ${pins.join(", ")}`;
      }

      case "pcb_generate": {
        const project = args.project as string;
        const metaPath = path.join(PROJECT_DIR, project, "project.json");
        if (!fs.existsSync(metaPath)) return `Project not found: ${project}`;

        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const projDir = path.join(PROJECT_DIR, project);

        // Generate all files
        fs.writeFileSync(
          path.join(projDir, `${project}.kicad_sch`),
          generateKicadSchematic(meta.components, meta.wires, meta.nets, project),
        );
        fs.writeFileSync(
          path.join(projDir, `${project}.net`),
          generateNetlist(meta.components, meta.netConnections),
        );
        fs.writeFileSync(
          path.join(projDir, `${project}_bom.csv`),
          generateBOM(meta.components),
        );
        fs.writeFileSync(
          path.join(projDir, "gerbers", `${project}.gbrjob`),
          generateGerberJobFile(project),
        );

        return [
          `Generated files for "${project}":`,
          `  📐 ${project}.kicad_sch — Schematic`,
          `  🔗 ${project}.net — Netlist`,
          `  📋 ${project}_bom.csv — Bill of Materials (${meta.components.length} components)`,
          `  🏭 gerbers/${project}.gbrjob — Gerber job file`,
          `\nLocation: ${projDir}`,
        ].join("\n");
      }

      case "pcb_list_templates": {
        return Object.entries(TEMPLATES).map(([name, fn]) => {
          const t = fn();
          return `• ${name} — ${t.description} (${t.components.length} components)`;
        }).join("\n");
      }

      case "pcb_list_projects": {
        if (!fs.existsSync(PROJECT_DIR)) return "No projects yet.";
        const dirs = fs.readdirSync(PROJECT_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        if (dirs.length === 0) return "No projects yet.";

        return dirs.map(d => {
          const metaPath = path.join(PROJECT_DIR, d.name, "project.json");
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            return `• ${d.name} — ${meta.description || "(no description)"} (${meta.components?.length || 0} components)`;
          }
          return `• ${d.name}`;
        }).join("\n");
      }

      case "pcb_export_bom": {
        const project = args.project as string;
        const format = (args.format as string) || "csv";
        const metaPath = path.join(PROJECT_DIR, project, "project.json");
        if (!fs.existsSync(metaPath)) return `Project not found: ${project}`;

        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));

        if (format === "json") {
          return JSON.stringify(meta.components.map((c: any) => ({
            reference: c.ref, value: c.value, library: c.lib, symbol: c.symbol,
          })), null, 2);
        }

        return generateBOM(meta.components);
      }

      case "pcb_design_review": {
        const project = args.project as string;
        const metaPath = path.join(PROJECT_DIR, project, "project.json");
        if (!fs.existsSync(metaPath)) return `Project not found: ${project}`;

        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const issues: string[] = [];
        const warnings: string[] = [];

        // Check for power nets
        const netNames = (meta.netConnections || []).map((n: any) => n.name);
        if (!netNames.includes("VCC") && !netNames.includes("3V3") && !netNames.includes("5V")) {
          issues.push("No power net found (VCC, 3V3, or 5V)");
        }
        if (!netNames.includes("GND")) {
          issues.push("No GND net found");
        }

        // Check for decoupling caps
        const caps = meta.components.filter((c: any) => c.ref.startsWith("C"));
        const ics = meta.components.filter((c: any) => c.ref.startsWith("U"));
        if (ics.length > 0 && caps.length < ics.length) {
          warnings.push(`Only ${caps.length} capacitors for ${ics.length} ICs — consider adding decoupling caps (100nF per IC)`);
        }

        // Check for pull-up resistors on I2C
        if (netNames.includes("SDA") || netNames.includes("SCL")) {
          const resistors = meta.components.filter((c: any) => c.ref.startsWith("R") && (c.value === "4.7K" || c.value === "4K7" || c.value === "10K"));
          if (resistors.length < 2) {
            warnings.push("I2C bus detected but missing pull-up resistors (4.7K recommended on SDA and SCL)");
          }
        }

        // Check for unconnected components
        const connectedRefs = new Set<string>();
        for (const net of meta.netConnections || []) {
          for (const pin of net.pins) connectedRefs.add(pin.split(".")[0]);
        }
        const unconnected = meta.components.filter((c: any) => !connectedRefs.has(c.ref));
        if (unconnected.length > 0) {
          warnings.push(`Unconnected components: ${unconnected.map((c: any) => c.ref).join(", ")}`);
        }

        if (issues.length === 0 && warnings.length === 0) {
          return `Design review for "${project}": ✓ No issues found (${meta.components.length} components, ${meta.netConnections?.length || 0} nets)`;
        }

        let result = `Design review for "${project}":\n`;
        if (issues.length > 0) result += `\nErrors:\n${issues.map(i => `  ✗ ${i}`).join("\n")}`;
        if (warnings.length > 0) result += `\nWarnings:\n${warnings.map(w => `  ⚠ ${w}`).join("\n")}`;
        return result;
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default pcbBuilder;

