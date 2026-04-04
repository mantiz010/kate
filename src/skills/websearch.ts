import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

interface SearchResult { title: string; url: string; snippet: string; }

async function searchGitHub(query: string, count: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const { stdout } = await execAsync(
      "curl -s -m 10 -H \"User-Agent: Kate\" \"https://api.github.com/search/repositories?q=" + encoded + "&sort=stars&per_page=" + count + "\"",
      { timeout: 15000 },
    );
    const data = JSON.parse(stdout);
    if (data.items) {
      return data.items.map((r: any) => ({
        title: r.full_name + " (" + (r.stargazers_count || 0) + " stars)",
        url: r.html_url,
        snippet: (r.description || "No description").slice(0, 150),
      }));
    }
  } catch {}
  return [];
}

async function searchWikipedia(query: string, count: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const { stdout } = await execAsync(
      "curl -s -m 10 \"https://en.wikipedia.org/w/api.php?action=opensearch&search=" + encoded + "&limit=" + count + "&format=json\"",
      { timeout: 10000 },
    );
    const data = JSON.parse(stdout);
    if (data.length >= 4) {
      const results: SearchResult[] = [];
      for (let i = 0; i < data[1].length; i++) {
        results.push({ title: data[1][i], url: data[3][i], snippet: data[2][i] || "" });
      }
      return results;
    }
  } catch {}
  return [];
}

async function searchStackOverflow(query: string, count: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const { stdout } = await execAsync(
      "curl -s -m 10 \"https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=" + encoded + "&site=stackoverflow&pagesize=" + count + "&filter=withbody\"",
      { timeout: 10000 },
    );
    const data = JSON.parse(stdout);
    if (data.items) {
      return data.items.map((r: any) => ({
        title: (r.title || "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
        url: r.link,
        snippet: (r.body || "").replace(/<[^>]+>/g, "").slice(0, 150),
      }));
    }
  } catch {}
  return [];
}

async function fetchClean(url: string, maxLen = 15000): Promise<string> {
  try {
    // Use native fetch — safe from command injection (no shell involved)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { "User-Agent": "Kate/1.0" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim().slice(0, maxLen);
  } catch (err: any) { return "Fetch error: " + err.message; }
}

const websearch: Skill = {
  id: "builtin.websearch",
  name: "Web Search",
  description: "Search the real web plus GitHub, Wikipedia, and StackOverflow. Fetch and read any URL.",
  version: "3.0.0",
  tools: [
    { name: "search", description: "Search the web (DuckDuckGo + GitHub + Wikipedia + StackOverflow)", parameters: [
      { name: "query", type: "string", description: "Search query", required: true },
      { name: "source", type: "string", description: "github, wikipedia, stackoverflow, or all (default: all)", required: false },
      { name: "count", type: "number", description: "Results per source (default: 5)", required: false },
    ]},
    { name: "search_and_read", description: "Search then fetch and read the top results", parameters: [
      { name: "query", type: "string", description: "Search query", required: true },
      { name: "count", type: "number", description: "How many to read (default: 3)", required: false },
    ]},
    { name: "fetch_page", description: "Fetch any URL and return clean readable text", parameters: [
      { name: "url", type: "string", description: "URL to fetch", required: true },
      { name: "maxLength", type: "number", description: "Max chars (default: 15000)", required: false },
    ]},
    { name: "fetch_json", description: "Fetch a URL and return raw JSON", parameters: [
      { name: "url", type: "string", description: "URL to fetch", required: true },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case "search": {
        const query = args.query as string;
        const source = (args.source as string) || "all";
        const count = (args.count as number) || 5;
        const sections: string[] = [];

        if (source === "all" || source === "web" || source === "ddg") {
          try {
            const { stdout } = await execAsync(
              "python3 /home/mantiz010/kate/scripts/web_search.py " + JSON.stringify(query),
              { timeout: 30000, maxBuffer: 1024 * 1024 },
            );
            const ddg = JSON.parse(stdout);
            if (ddg.length > 0) {
              sections.push("--- Web Results ---");
              sections.push(ddg.slice(0, count).map((r: any, i: number) => (i + 1) + ". " + r.title + "\n   " + r.url + "\n   " + r.snippet).join("\n\n"));
            }
          } catch {}
        }

        if (source === "all" || source === "github") {
          const gh = await searchGitHub(query, count);
          if (gh.length > 0) {
            sections.push("--- GitHub Repos ---");
            sections.push(gh.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url + "\n   " + r.snippet).join("\n\n"));
          }
        }

        if (source === "all" || source === "wikipedia") {
          const wiki = await searchWikipedia(query, count);
          if (wiki.length > 0) {
            sections.push("\n--- Wikipedia ---");
            sections.push(wiki.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url + "\n   " + r.snippet).join("\n\n"));
          }
        }

        if (source === "all" || source === "stackoverflow") {
          const so = await searchStackOverflow(query, count);
          if (so.length > 0) {
            sections.push("\n--- StackOverflow ---");
            sections.push(so.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.url + "\n   " + r.snippet).join("\n\n"));
          }
        }

        return sections.length > 0 ? sections.join("\n") : "No results found for: " + query;
      }

      case "search_and_read": {
        const n = (args.count as number) || 3;
        let results: SearchResult[] = [];
        try {
          const { stdout } = await execAsync(
            "python3 /home/mantiz010/kate/scripts/web_search.py " + JSON.stringify(args.query as string),
            { timeout: 30000, maxBuffer: 1024 * 1024 },
          );
          results = JSON.parse(stdout).map((r: any) => ({ title: r.title, url: r.url, snippet: r.snippet }));
        } catch {}
        if (results.length === 0) results = await searchGitHub(args.query as string, n);
        if (results.length === 0) return "No results for: " + args.query;
        const out: string[] = [];
        for (const r of results.slice(0, n)) {
          out.push("=== " + r.title + " ===\nURL: " + r.url);
          out.push(await fetchClean(r.url, 4000));
        }
        return out.join("\n\n");
      }

      case "fetch_page": {
        const maxLen = (args.maxLength as number) || 15000;
        return fetchClean(args.url as string, maxLen);
      }

      case "fetch_json": {
        try {
          // Use native fetch — safe from command injection
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const res = await fetch(args.url as string, {
            headers: { "Accept": "application/json", "User-Agent": "Kate/1.0" },
            signal: controller.signal,
            redirect: "follow",
          });
          clearTimeout(timer);
          const text = await res.text();
          return text.slice(0, 15000);
        } catch (err: any) { return "Error: " + err.message; }
      }

      default: return "Unknown tool: " + toolName;
    }
  },
};

export default websearch;
