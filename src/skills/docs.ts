import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DOCS_CACHE = path.join(os.homedir(), ".aegis", "docs-cache");

async function fetchText(url: string, maxLen = 20000): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Kate/1.0", "Accept": "text/html,application/json,text/plain,text/markdown" },
      signal: AbortSignal.timeout(15000),
    });
    const ct = res.headers.get("content-type") || "";

    if (ct.includes("json")) {
      const data = await res.json();
      return JSON.stringify(data, null, 2).slice(0, maxLen);
    }

    const html = await res.text();

    // If markdown, return as-is
    if (ct.includes("markdown") || url.endsWith(".md") || url.includes("raw.githubusercontent.com")) {
      return html.slice(0, maxLen);
    }

    // Extract main content from HTML
    let content = html;

    // Try to find main content area
    const mainMatch = content.match(/<(?:main|article|div[^>]*class="[^"]*(?:content|docs|body|markdown|article)[^"]*")[^>]*>([\s\S]*?)<\/(?:main|article|div)>/i);
    if (mainMatch) content = mainMatch[1];

    // Strip tags
    content = content
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside[\s\S]*?<\/aside>/gi, "")
      // Preserve code blocks
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      // Headings
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
      // Lists
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "  • $1\n")
      // Paragraphs
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Links - keep text
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Entities
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return content.slice(0, maxLen);
  } catch (err: any) {
    return `Error fetching: ${err.message}`;
  }
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = [];
  const regex = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null && links.length < 50) {
    let url = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    if (!text || url.startsWith("#") || url.startsWith("javascript:")) continue;
    if (url.startsWith("/")) {
      const base = new URL(baseUrl);
      url = `${base.protocol}//${base.host}${url}`;
    }
    links.push({ text, url });
  }
  return links;
}

const docsScraper: Skill = {
  id: "builtin.docs",
  name: "Docs Scraper",
  description: "Read documentation sites, API docs, wikis, and README files. Extracts clean text from HTML, preserves code blocks, caches locally.",
  version: "1.0.0",
  tools: [
    { name: "docs_read", description: "Read a documentation page and extract clean text with code blocks preserved", parameters: [
      { name: "url", type: "string", description: "Documentation URL to read", required: true },
      { name: "maxLength", type: "number", description: "Max text length (default: 20000)", required: false },
    ]},
    { name: "docs_links", description: "Extract all links from a docs page (useful to find sub-pages)", parameters: [
      { name: "url", type: "string", description: "Page URL to extract links from", required: true },
      { name: "filter", type: "string", description: "Filter links containing this text", required: false },
    ]},
    { name: "docs_crawl", description: "Read a docs page and follow links to read sub-pages (limited depth crawl)", parameters: [
      { name: "url", type: "string", description: "Starting URL", required: true },
      { name: "maxPages", type: "number", description: "Max pages to read (default: 5)", required: false },
      { name: "filter", type: "string", description: "Only follow links containing this text", required: false },
    ]},
    { name: "docs_github_wiki", description: "Read a GitHub project's wiki pages", parameters: [
      { name: "repo", type: "string", description: "GitHub repo (owner/repo)", required: true },
    ]},
    { name: "docs_api_spec", description: "Fetch and parse an OpenAPI/Swagger spec from a URL", parameters: [
      { name: "url", type: "string", description: "URL of the OpenAPI JSON/YAML spec", required: true },
    ]},
    { name: "docs_cache_save", description: "Save fetched docs to local cache for offline access", parameters: [
      { name: "url", type: "string", description: "URL to cache", required: true },
      { name: "name", type: "string", description: "Cache name/key", required: true },
    ]},
    { name: "docs_cache_read", description: "Read from local docs cache", parameters: [
      { name: "name", type: "string", description: "Cache name/key", required: true },
    ]},
    { name: "docs_cache_list", description: "List all cached documentation", parameters: [] },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "docs_read": {
        return fetchText(args.url as string, (args.maxLength as number) || 20000);
      }

      case "docs_links": {
        try {
          const res = await fetch(args.url as string, {
            headers: { "User-Agent": "Kate/1.0" },
            signal: AbortSignal.timeout(10000),
          });
          const html = await res.text();
          let links = extractLinks(html, args.url as string);
          if (args.filter) {
            const f = (args.filter as string).toLowerCase();
            links = links.filter(l => l.text.toLowerCase().includes(f) || l.url.toLowerCase().includes(f));
          }
          return links.map(l => `${l.text}\n  ${l.url}`).join("\n") || "No links found.";
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      }

      case "docs_crawl": {
        const maxPages = (args.maxPages as number) || 5;
        const filter = (args.filter as string)?.toLowerCase();
        const startUrl = args.url as string;
        const visited = new Set<string>();
        const output: string[] = [];

        const queue = [startUrl];
        while (queue.length > 0 && visited.size < maxPages) {
          const url = queue.shift()!;
          if (visited.has(url)) continue;
          visited.add(url);

          output.push(`\n═══ ${url} ═══\n`);
          const text = await fetchText(url, 5000);
          output.push(text);

          // Extract links for next pages
          try {
            const res = await fetch(url, { headers: { "User-Agent": "Kate/1.0" }, signal: AbortSignal.timeout(8000) });
            const html = await res.text();
            const links = extractLinks(html, url);
            for (const link of links) {
              if (!visited.has(link.url) && link.url.startsWith("http")) {
                if (filter && !link.url.toLowerCase().includes(filter) && !link.text.toLowerCase().includes(filter)) continue;
                // Stay on same domain
                if (new URL(link.url).host === new URL(startUrl).host) {
                  queue.push(link.url);
                }
              }
            }
          } catch {}
        }

        return output.join("\n").slice(0, 50000);
      }

      case "docs_github_wiki": {
        const repo = args.repo as string;
        const url = `https://github.com/${repo}/wiki`;
        try {
          const res = await fetch(url, { headers: { "User-Agent": "Kate/1.0" }, signal: AbortSignal.timeout(10000) });
          const html = await res.text();
          if (html.includes("does not have a wiki")) return `${repo} does not have a wiki.`;
          const links = extractLinks(html, url).filter(l => l.url.includes("/wiki/"));
          const content = await fetchText(url, 10000);
          return `Wiki pages:\n${links.map(l => `  • ${l.text} — ${l.url}`).join("\n")}\n\nMain page:\n${content}`;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      }

      case "docs_api_spec": {
        try {
          const res = await fetch(args.url as string, {
            headers: { "User-Agent": "Kate/1.0", "Accept": "application/json" },
            signal: AbortSignal.timeout(10000),
          });
          const spec = await res.json() as any;
          const output: string[] = [];
          output.push(`API: ${spec.info?.title || "Unknown"} v${spec.info?.version || "?"}`);
          output.push(`Description: ${spec.info?.description || "(none)"}`);
          output.push("");

          if (spec.paths) {
            output.push("Endpoints:");
            for (const [path, methods] of Object.entries(spec.paths)) {
              for (const [method, details] of Object.entries(methods as any)) {
                if (["get", "post", "put", "delete", "patch"].includes(method)) {
                  output.push(`  ${method.toUpperCase()} ${path} — ${(details as any).summary || ""}`);
                }
              }
            }
          }

          return output.join("\n").slice(0, 15000);
        } catch (err: any) {
          return `Error parsing spec: ${err.message}`;
        }
      }

      case "docs_cache_save": {
        if (!fs.existsSync(DOCS_CACHE)) fs.mkdirSync(DOCS_CACHE, { recursive: true });
        const text = await fetchText(args.url as string, 50000);
        const name = (args.name as string).replace(/[^a-zA-Z0-9-_]/g, "-");
        fs.writeFileSync(path.join(DOCS_CACHE, `${name}.md`), `<!-- Source: ${args.url} -->\n<!-- Cached: ${new Date().toISOString()} -->\n\n${text}`);
        return `Cached: ${name} (${text.length} chars)`;
      }

      case "docs_cache_read": {
        const name = (args.name as string).replace(/[^a-zA-Z0-9-_]/g, "-");
        const file = path.join(DOCS_CACHE, `${name}.md`);
        if (!fs.existsSync(file)) return `Not in cache: ${name}`;
        return fs.readFileSync(file, "utf-8");
      }

      case "docs_cache_list": {
        if (!fs.existsSync(DOCS_CACHE)) return "No cached docs.";
        const files = fs.readdirSync(DOCS_CACHE).filter(f => f.endsWith(".md"));
        if (files.length === 0) return "No cached docs.";
        return files.map(f => {
          const stat = fs.statSync(path.join(DOCS_CACHE, f));
          return `• ${f.replace(".md", "")} (${(stat.size / 1024).toFixed(1)}KB, ${stat.mtime.toLocaleDateString()})`;
        }).join("\n");
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default docsScraper;

