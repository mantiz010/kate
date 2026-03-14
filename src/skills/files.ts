import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";

const files: Skill = {
  id: "builtin.files",
  name: "Files",
  description: "Read, write, and manage files on the host machine",
  version: "1.0.0",
  tools: [
    {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: [
        { name: "path", type: "string", description: "Absolute or relative file path", required: true },
        { name: "encoding", type: "string", description: "File encoding (default: utf-8)", required: false },
      ],
    },
    {
      name: "write_file",
      description: "Write content to a file (creates directories if needed)",
      parameters: [
        { name: "path", type: "string", description: "File path to write to", required: true },
        { name: "content", type: "string", description: "Content to write", required: true },
        { name: "append", type: "boolean", description: "Append instead of overwrite", required: false },
      ],
    },
    {
      name: "list_directory",
      description: "List files and directories in a path",
      parameters: [
        { name: "path", type: "string", description: "Directory path to list", required: true },
        { name: "recursive", type: "boolean", description: "List recursively (default: false)", required: false },
      ],
    },
    {
      name: "file_info",
      description: "Get metadata about a file (size, modified date, type)",
      parameters: [
        { name: "path", type: "string", description: "File path", required: true },
      ],
    },
    {
      name: "search_files",
      description: "Search for files matching a pattern in a directory",
      parameters: [
        { name: "directory", type: "string", description: "Directory to search in", required: true },
        { name: "pattern", type: "string", description: "Filename pattern to match (glob-like)", required: true },
        { name: "content", type: "string", description: "Search for this text inside files", required: false },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "read_file": {
        const filePath = args.path as string;
        const encoding = (args.encoding as BufferEncoding) || "utf-8";
        try {
          const content = fs.readFileSync(filePath, encoding);
          return content.slice(0, 50000); // Cap at 50k chars
        } catch (err: any) {
          return `Error reading file: ${err.message}`;
        }
      }

      case "write_file": {
        const filePath = args.path as string;
        const content = args.content as string;
        const append = args.append as boolean || false;
        try {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          if (append) {
            fs.appendFileSync(filePath, content, "utf-8");
          } else {
            fs.writeFileSync(filePath, content, "utf-8");
          }
          return `File ${append ? "appended" : "written"}: ${filePath} (${content.length} chars)`;
        } catch (err: any) {
          return `Error writing file: ${err.message}`;
        }
      }

      case "list_directory": {
        const dirPath = (args.path as string).replace(/^~/, process.env.HOME || "/root").replace(/^~/, process.env.HOME || "/root");
        const recursive = args.recursive as boolean || false;
        try {
          if (recursive) {
            const results: string[] = [];
            function walk(dir: string, depth: number) {
              if (depth > 4) return;
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const e of entries) {
                if (e.name.startsWith(".") || e.name === "node_modules") continue;
                const full = path.join(dir, e.name);
                const rel = path.relative(dirPath, full);
                results.push(`${e.isDirectory() ? "📁" : "📄"} ${rel}`);
                if (e.isDirectory()) walk(full, depth + 1);
              }
            }
            walk(dirPath, 0);
            return results.slice(0, 200).join("\n") || "(empty directory)";
          } else {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
              .map(e => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
              .join("\n") || "(empty directory)";
          }
        } catch (err: any) {
          return `Error listing directory: ${err.message}`;
        }
      }

      case "file_info": {
        const filePath = args.path as string;
        try {
          const stat = fs.statSync(filePath);
          return [
            `Path: ${filePath}`,
            `Type: ${stat.isDirectory() ? "directory" : "file"}`,
            `Size: ${formatSize(stat.size)}`,
            `Modified: ${stat.mtime.toISOString()}`,
            `Created: ${stat.birthtime.toISOString()}`,
            `Permissions: ${(stat.mode & 0o777).toString(8)}`,
          ].join("\n");
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      }

      case "search_files": {
        const dir = args.directory as string;
        const pattern = (args.pattern as string).toLowerCase();
        const contentSearch = args.content as string | undefined;
        const results: string[] = [];

        function search(searchDir: string, depth: number) {
          if (depth > 5 || results.length > 50) return;
          try {
            const entries = fs.readdirSync(searchDir, { withFileTypes: true });
            for (const e of entries) {
              if (e.name.startsWith(".") || e.name === "node_modules") continue;
              const full = path.join(searchDir, e.name);
              if (e.isDirectory()) {
                search(full, depth + 1);
              } else if (e.name.toLowerCase().includes(pattern)) {
                if (contentSearch) {
                  try {
                    const text = fs.readFileSync(full, "utf-8");
                    if (text.toLowerCase().includes(contentSearch.toLowerCase())) {
                      results.push(full);
                    }
                  } catch {}
                } else {
                  results.push(full);
                }
              }
            }
          } catch {}
        }

        search(dir, 0);
        return results.length > 0
          ? `Found ${results.length} file(s):\n${results.join("\n")}`
          : "No files found matching the criteria.";
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default files;

