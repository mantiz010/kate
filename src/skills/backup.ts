import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 120000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return (stdout || stderr || "(no output)").slice(0, 8000);
  } catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 3000); }
};

const BACKUP_DIR = path.join(os.homedir(), ".aegis", "backups");
const JOBS_FILE = path.join(os.homedir(), ".aegis", "backup-jobs.json");

interface BackupJob { name: string; sources: string[]; dest: string; compress: boolean; keep: number; lastRun?: number; lastSize?: string; }
let jobs: BackupJob[] = [];
function loadJobs() { try { if (fs.existsSync(JOBS_FILE)) jobs = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8")); } catch {} }
function saveJobs() { const d = path.dirname(JOBS_FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); }

const backup: Skill = {
  id: "builtin.backup",
  name: "Backup",
  description: "Create, schedule, and manage backups. Supports files, directories, databases, configs. Compression, rotation, and restore.",
  version: "1.0.0",
  tools: [
    { name: "backup_create", description: "Create a backup of files/directories right now", parameters: [
      { name: "source", type: "string", description: "File or directory to backup (comma-separated for multiple)", required: true },
      { name: "name", type: "string", description: "Backup name (default: auto-generated)", required: false },
      { name: "dest", type: "string", description: "Destination directory (default: ~/.aegis/backups/)", required: false },
      { name: "compress", type: "boolean", description: "Compress with gzip (default: true)", required: false },
    ]},
    { name: "backup_job_create", description: "Create a reusable backup job definition", parameters: [
      { name: "name", type: "string", description: "Job name", required: true },
      { name: "sources", type: "string", description: "Comma-separated paths to backup", required: true },
      { name: "dest", type: "string", description: "Backup destination", required: false },
      { name: "compress", type: "boolean", description: "Compress (default: true)", required: false },
      { name: "keep", type: "number", description: "Keep last N backups (default: 5)", required: false },
    ]},
    { name: "backup_job_run", description: "Run a saved backup job", parameters: [
      { name: "name", type: "string", description: "Job name", required: true },
    ]},
    { name: "backup_job_list", description: "List all backup jobs", parameters: [] },
    { name: "backup_list", description: "List existing backup files", parameters: [
      { name: "path", type: "string", description: "Backup directory (default: ~/.aegis/backups/)", required: false },
    ]},
    { name: "backup_restore", description: "Restore a backup to a destination", parameters: [
      { name: "backup", type: "string", description: "Backup file path", required: true },
      { name: "dest", type: "string", description: "Restore destination", required: true },
    ]},
    { name: "backup_kate", description: "Backup the entire Kate installation (config, skills, memory)", parameters: [] },
    { name: "backup_cleanup", description: "Remove old backups, keeping only the latest N", parameters: [
      { name: "keep", type: "number", description: "Number to keep (default: 5)", required: false },
      { name: "path", type: "string", description: "Backup directory", required: false },
    ]},
  ],

  async onLoad() { loadJobs(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    switch (toolName) {
      case "backup_create": {
        const sources = (args.source as string).split(",").map(s => s.trim().replace("~", os.homedir()));
        const name = (args.name as string) || `backup-${Date.now()}`;
        const dest = ((args.dest as string) || BACKUP_DIR).replace("~", os.homedir());
        const compress = args.compress !== false;

        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = compress ? `${name}_${ts}.tar.gz` : `${name}_${ts}.tar`;
        const outPath = path.join(dest, filename);

        const srcList = sources.join(" ");
        const cmd = compress
          ? `tar czf "${outPath}" ${srcList} 2>&1`
          : `tar cf "${outPath}" ${srcList} 2>&1`;

        const result = await run(cmd, 300000);
        if (fs.existsSync(outPath)) {
          const size = fs.statSync(outPath).size;
          return `✓ Backup created: ${outPath}\n  Size: ${fmtSize(size)}\n  Sources: ${sources.join(", ")}`;
        }
        return `Backup may have failed:\n${result}`;
      }

      case "backup_job_create": {
        loadJobs();
        const job: BackupJob = {
          name: args.name as string,
          sources: (args.sources as string).split(",").map(s => s.trim()),
          dest: ((args.dest as string) || BACKUP_DIR).replace("~", os.homedir()),
          compress: args.compress !== false,
          keep: (args.keep as number) || 5,
        };
        jobs = jobs.filter(j => j.name !== job.name);
        jobs.push(job);
        saveJobs();
        return `Job created: ${job.name}\n  Sources: ${job.sources.join(", ")}\n  Dest: ${job.dest}\n  Keep: ${job.keep}\n  Run: backup_job_run name="${job.name}"`;
      }

      case "backup_job_run": {
        loadJobs();
        const job = jobs.find(j => j.name === args.name);
        if (!job) return `Job not found: ${args.name}`;

        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = job.compress ? `${job.name}_${ts}.tar.gz` : `${job.name}_${ts}.tar`;
        const outPath = path.join(job.dest, filename);

        if (!fs.existsSync(job.dest)) fs.mkdirSync(job.dest, { recursive: true });

        const srcList = job.sources.map(s => s.replace("~", os.homedir())).join(" ");
        const cmd = job.compress ? `tar czf "${outPath}" ${srcList} 2>&1` : `tar cf "${outPath}" ${srcList} 2>&1`;
        await run(cmd, 300000);

        // Rotate old backups
        const existing = fs.readdirSync(job.dest)
          .filter(f => f.startsWith(job.name + "_"))
          .sort().reverse();
        for (let i = job.keep; i < existing.length; i++) {
          fs.unlinkSync(path.join(job.dest, existing[i]));
        }

        job.lastRun = Date.now();
        job.lastSize = fs.existsSync(outPath) ? fmtSize(fs.statSync(outPath).size) : "?";
        saveJobs();

        return `✓ Job "${job.name}" complete: ${outPath}\n  Size: ${job.lastSize}\n  Kept: ${Math.min(existing.length + 1, job.keep)} backups`;
      }

      case "backup_job_list": {
        loadJobs();
        if (jobs.length === 0) return "No backup jobs. Create one with backup_job_create.";
        return jobs.map(j => {
          const last = j.lastRun ? new Date(j.lastRun).toLocaleString() : "never";
          return `• ${j.name}\n  Sources: ${j.sources.join(", ")}\n  Keep: ${j.keep} | Last: ${last} | Size: ${j.lastSize || "?"}`;
        }).join("\n\n");
      }

      case "backup_list": {
        const dir = ((args.path as string) || BACKUP_DIR).replace("~", os.homedir());
        if (!fs.existsSync(dir)) return "No backups found.";
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".tar") || f.endsWith(".tar.gz") || f.endsWith(".zip")).sort().reverse();
        if (files.length === 0) return "No backup files found.";
        return files.map(f => {
          const s = fs.statSync(path.join(dir, f));
          return `  ${f} (${fmtSize(s.size)}, ${s.mtime.toLocaleDateString()})`;
        }).join("\n");
      }

      case "backup_restore": {
        const bk = (args.backup as string).replace("~", os.homedir());
        const dest = (args.dest as string).replace("~", os.homedir());
        if (!fs.existsSync(bk)) return `Backup not found: ${bk}`;
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        return run(`tar xzf "${bk}" -C "${dest}" 2>&1 || tar xf "${bk}" -C "${dest}" 2>&1`);
      }

      case "backup_kate": {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const outPath = path.join(BACKUP_DIR, `kate-full_${ts}.tar.gz`);
        const kateDir = os.homedir() + "/.aegis";
        const projectDir = os.homedir() + "/kate";
        await run(`tar czf "${outPath}" "${kateDir}" "${projectDir}/src" "${projectDir}/package.json" "${projectDir}/tsconfig.json" 2>&1`, 120000);
        if (fs.existsSync(outPath)) {
          return `✓ Kate backup: ${outPath}\n  Size: ${fmtSize(fs.statSync(outPath).size)}`;
        }
        return "Backup may have failed";
      }

      case "backup_cleanup": {
        const keep = (args.keep as number) || 5;
        const dir = ((args.path as string) || BACKUP_DIR).replace("~", os.homedir());
        if (!fs.existsSync(dir)) return "Directory not found.";
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".tar") || f.endsWith(".tar.gz")).sort().reverse();
        let removed = 0;
        for (let i = keep; i < files.length; i++) {
          fs.unlinkSync(path.join(dir, files[i]));
          removed++;
        }
        return `Cleaned up: removed ${removed} old backups, kept ${Math.min(files.length, keep)}`;
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};

function fmtSize(b: number): string {
  if (b < 1024) return b + "B";
  if (b < 1048576) return (b / 1024).toFixed(1) + "KB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + "MB";
  return (b / 1073741824).toFixed(1) + "GB";
}

export default backup;

