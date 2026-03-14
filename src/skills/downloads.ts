import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const DL_DIR = path.join(os.homedir(), "Downloads");

const run = async (cmd: string, timeout = 300000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 5 });
    return (stdout || stderr || "(no output)").slice(0, 5000);
  } catch (err: any) {
    return `Error: ${err.stderr || err.message}`.slice(0, 3000);
  }
};

const downloads: Skill = {
  id: "builtin.downloads",
  name: "Downloads",
  description: "Download files, clone git repos, extract archives. Supports HTTP, git clone, wget with progress.",
  version: "1.0.0",
  tools: [
    { name: "download_file", description: "Download a file from a URL to local disk", parameters: [
      { name: "url", type: "string", description: "URL to download", required: true },
      { name: "dest", type: "string", description: "Destination path (default: ~/Downloads/)", required: false },
      { name: "filename", type: "string", description: "Override filename", required: false },
    ]},
    { name: "download_git", description: "Clone a git repository", parameters: [
      { name: "url", type: "string", description: "Git repo URL or GitHub shorthand (owner/repo)", required: true },
      { name: "dest", type: "string", description: "Destination directory", required: false },
      { name: "branch", type: "string", description: "Specific branch to clone", required: false },
      { name: "shallow", type: "boolean", description: "Shallow clone (--depth 1)", required: false },
    ]},
    { name: "download_github_release", description: "Download the latest release asset from a GitHub repo", parameters: [
      { name: "repo", type: "string", description: "GitHub repo (owner/repo)", required: true },
      { name: "asset", type: "string", description: "Asset filename pattern to match (e.g. 'linux', '.tar.gz')", required: false },
      { name: "dest", type: "string", description: "Destination directory", required: false },
    ]},
    { name: "download_extract", description: "Extract an archive (zip, tar.gz, tar.bz2, 7z)", parameters: [
      { name: "file", type: "string", description: "Archive file path", required: true },
      { name: "dest", type: "string", description: "Extract to directory", required: false },
    ]},
    { name: "download_list", description: "List downloaded files in ~/Downloads", parameters: [
      { name: "filter", type: "string", description: "Filter by name pattern", required: false },
    ]},
    { name: "download_batch", description: "Download multiple files at once", parameters: [
      { name: "urls", type: "string", description: "URLs separated by newlines or | pipes", required: true },
      { name: "dest", type: "string", description: "Destination directory", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

    switch (toolName) {
      case "download_file": {
        const url = args.url as string;
        const dest = (args.dest as string) || DL_DIR;
        const filename = (args.filename as string) || url.split("/").pop()?.split("?")[0] || "download";
        const outPath = path.join(dest, filename);

        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

        ctx.log.info(`Downloading: ${url} → ${outPath}`);
        const result = await run(`curl -L -o "${outPath}" --progress-bar "${url}" 2>&1`);

        if (fs.existsSync(outPath)) {
          const size = fs.statSync(outPath).size;
          return `Downloaded: ${outPath} (${formatSize(size)})`;
        }
        return `Download may have failed:\n${result}`;
      }

      case "download_git": {
        let url = args.url as string;
        // GitHub shorthand
        if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(url)) {
          url = `https://github.com/${url}.git`;
        }

        const repoName = url.split("/").pop()?.replace(".git", "") || "repo";
        const dest = (args.dest as string) || path.join(DL_DIR, repoName);
        const branch = args.branch ? `-b ${args.branch}` : "";
        const shallow = (args.shallow as boolean) !== false ? "--depth 1" : "";

        ctx.log.info(`Cloning: ${url} → ${dest}`);
        const result = await run(`git clone ${shallow} ${branch} "${url}" "${dest}" 2>&1`);
        return result;
      }

      case "download_github_release": {
        const repo = args.repo as string;
        const assetFilter = (args.asset as string)?.toLowerCase();
        const dest = (args.dest as string) || DL_DIR;

        try {
          const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { "User-Agent": "Kate/1.0" },
          });
          const data = await res.json() as any;

          if (!data.assets?.length) return `No release assets found for ${repo}`;

          let asset = data.assets[0];
          if (assetFilter) {
            const match = data.assets.find((a: any) => a.name.toLowerCase().includes(assetFilter));
            if (match) asset = match;
          }

          ctx.log.info(`Downloading release: ${asset.name}`);
          const outPath = path.join(dest, asset.name);
          const result = await run(`curl -L -o "${outPath}" "${asset.browser_download_url}" 2>&1`);

          if (fs.existsSync(outPath)) {
            return `Downloaded: ${asset.name} (${formatSize(asset.size)})\nVersion: ${data.tag_name}\nPath: ${outPath}`;
          }
          return `Download may have failed:\n${result}`;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      }

      case "download_extract": {
        const file = args.file as string;
        const dest = (args.dest as string) || path.dirname(file);

        if (!fs.existsSync(file)) return `File not found: ${file}`;

        let cmd: string;
        if (file.endsWith(".zip")) cmd = `unzip -o "${file}" -d "${dest}"`;
        else if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) cmd = `tar xzf "${file}" -C "${dest}"`;
        else if (file.endsWith(".tar.bz2")) cmd = `tar xjf "${file}" -C "${dest}"`;
        else if (file.endsWith(".tar.xz")) cmd = `tar xJf "${file}" -C "${dest}"`;
        else if (file.endsWith(".7z")) cmd = `7z x "${file}" -o"${dest}"`;
        else return `Unsupported format: ${path.extname(file)}`;

        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        return run(cmd, 120000);
      }

      case "download_list": {
        const filter = (args.filter as string)?.toLowerCase();
        if (!fs.existsSync(DL_DIR)) return "Downloads directory is empty.";

        let files = fs.readdirSync(DL_DIR, { withFileTypes: true });
        if (filter) files = files.filter(f => f.name.toLowerCase().includes(filter));

        return files.slice(0, 30).map(f => {
          const stat = fs.statSync(path.join(DL_DIR, f.name));
          return `${f.isDirectory() ? "📁" : "📄"} ${f.name} ${f.isFile() ? `(${formatSize(stat.size)})` : ""}`;
        }).join("\n") || "No files found.";
      }

      case "download_batch": {
        const urls = (args.urls as string).split(/[|\n]/).map(u => u.trim()).filter(Boolean);
        const dest = (args.dest as string) || DL_DIR;
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

        const results: string[] = [];
        for (const url of urls) {
          const filename = url.split("/").pop()?.split("?")[0] || "file";
          const outPath = path.join(dest, filename);
          await run(`curl -L -s -o "${outPath}" "${url}"`);
          if (fs.existsSync(outPath)) {
            results.push(`✓ ${filename} (${formatSize(fs.statSync(outPath).size)})`);
          } else {
            results.push(`✗ ${filename} — failed`);
          }
        }
        return `Downloaded ${results.filter(r => r.startsWith("✓")).length}/${urls.length}:\n${results.join("\n")}`;
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export default downloads;

