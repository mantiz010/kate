import type { Skill, SkillContext } from "../core/types.js";

const GH_API = "https://api.github.com";
const HEADERS = {
  "User-Agent": "Kate/1.0",
  "Accept": "application/vnd.github.v3+json",
};

async function ghFetch(path: string, token?: string): Promise<any> {
  const headers: Record<string, string> = { ...HEADERS };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${GH_API}${path}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

const github: Skill = {
  id: "builtin.github",
  name: "GitHub Search",
  description: "Search GitHub repos, code, issues, users, and gists. Read READMEs, file contents, and release info. No API key needed for public repos.",
  version: "1.0.0",
  tools: [
    { name: "gh_search_repos", description: "Search GitHub repositories by keyword, language, stars", parameters: [
      { name: "query", type: "string", description: "Search query (e.g. 'esp32 zigbee arduino')", required: true },
      { name: "language", type: "string", description: "Filter by language (e.g. 'C++', 'Python')", required: false },
      { name: "sort", type: "string", description: "Sort by: stars, forks, updated (default: stars)", required: false },
      { name: "count", type: "number", description: "Max results (default: 10)", required: false },
    ]},
    { name: "gh_search_code", description: "Search for code across all public GitHub repos", parameters: [
      { name: "query", type: "string", description: "Code search query", required: true },
      { name: "language", type: "string", description: "Filter by language", required: false },
      { name: "repo", type: "string", description: "Limit to specific repo (owner/repo)", required: false },
      { name: "count", type: "number", description: "Max results (default: 10)", required: false },
    ]},
    { name: "gh_search_issues", description: "Search GitHub issues and PRs across repos", parameters: [
      { name: "query", type: "string", description: "Issue search query", required: true },
      { name: "state", type: "string", description: "open, closed, or all (default: open)", required: false },
      { name: "count", type: "number", description: "Max results (default: 10)", required: false },
    ]},
    { name: "gh_readme", description: "Fetch the README of a repository", parameters: [
      { name: "repo", type: "string", description: "Repository (owner/repo)", required: true },
    ]},
    { name: "gh_file", description: "Read a specific file from a GitHub repository", parameters: [
      { name: "repo", type: "string", description: "Repository (owner/repo)", required: true },
      { name: "path", type: "string", description: "File path in the repo", required: true },
      { name: "branch", type: "string", description: "Branch (default: main)", required: false },
    ]},
    { name: "gh_tree", description: "List files and directories in a GitHub repo", parameters: [
      { name: "repo", type: "string", description: "Repository (owner/repo)", required: true },
      { name: "path", type: "string", description: "Directory path (default: root)", required: false },
    ]},
    { name: "gh_releases", description: "List releases of a repository", parameters: [
      { name: "repo", type: "string", description: "Repository (owner/repo)", required: true },
      { name: "count", type: "number", description: "Max releases (default: 5)", required: false },
    ]},
    { name: "gh_repo_info", description: "Get detailed info about a repository", parameters: [
      { name: "repo", type: "string", description: "Repository (owner/repo)", required: true },
    ]},
    { name: "gh_user", description: "Get info about a GitHub user or org", parameters: [
      { name: "username", type: "string", description: "GitHub username", required: true },
    ]},
    { name: "gh_trending", description: "Get trending repositories (via scraping)", parameters: [
      { name: "language", type: "string", description: "Filter by language (optional)", required: false },
      { name: "since", type: "string", description: "daily, weekly, monthly (default: daily)", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "gh_search_repos": {
        const count = (args.count as number) || 10;
        const lang = args.language ? `+language:${args.language}` : "";
        const sort = (args.sort as string) || "stars";
        const data = await ghFetch(`/search/repositories?q=${encodeURIComponent(args.query as string)}${lang}&sort=${sort}&per_page=${count}`);

        if (!data.items?.length) return "No repositories found.";
        return `Found ${data.total_count} repos:\n\n` + data.items.map((r: any) =>
          `⭐ ${r.stargazers_count} | ${r.full_name}\n  ${r.description || "(no description)"}\n  ${r.html_url}\n  Language: ${r.language || "?"} | Forks: ${r.forks_count} | Updated: ${r.updated_at?.slice(0, 10)}`
        ).join("\n\n");
      }

      case "gh_search_code": {
        const count = (args.count as number) || 10;
        const repo = args.repo ? `+repo:${args.repo}` : "";
        const lang = args.language ? `+language:${args.language}` : "";
        const data = await ghFetch(`/search/code?q=${encodeURIComponent(args.query as string)}${repo}${lang}&per_page=${count}`);

        if (!data.items?.length) return "No code results found.";
        return `Found ${data.total_count} code matches:\n\n` + data.items.map((r: any) =>
          `📄 ${r.repository.full_name}/${r.path}\n  ${r.html_url}`
        ).join("\n\n");
      }

      case "gh_search_issues": {
        const count = (args.count as number) || 10;
        const state = args.state ? `+state:${args.state}` : "";
        const data = await ghFetch(`/search/issues?q=${encodeURIComponent(args.query as string)}${state}&per_page=${count}`);

        if (!data.items?.length) return "No issues found.";
        return data.items.map((i: any) =>
          `${i.pull_request ? "PR" : "Issue"} #${i.number} [${i.state}] ${i.title}\n  ${i.html_url}\n  ${i.repository_url?.split("/").slice(-2).join("/") || ""} | ${i.comments} comments`
        ).join("\n\n");
      }

      case "gh_readme": {
        try {
          const data = await ghFetch(`/repos/${args.repo}/readme`);
          const content = Buffer.from(data.content, "base64").toString("utf-8");
          return content.slice(0, 15000);
        } catch {
          return `Could not fetch README for ${args.repo}`;
        }
      }

      case "gh_file": {
        const branch = (args.branch as string) || "main";
        try {
          const res = await fetch(`https://raw.githubusercontent.com/${args.repo}/${branch}/${args.path}`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) throw new Error(`${res.status}`);
          const text = await res.text();
          return text.slice(0, 20000);
        } catch (err: any) {
          // Try master branch
          try {
            const res = await fetch(`https://raw.githubusercontent.com/${args.repo}/master/${args.path}`, {
              signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            return (await res.text()).slice(0, 20000);
          } catch {
            return `Could not fetch ${args.path} from ${args.repo}: ${err.message}`;
          }
        }
      }

      case "gh_tree": {
        const p = (args.path as string) || "";
        const data = await ghFetch(`/repos/${args.repo}/contents/${p}`);
        if (!Array.isArray(data)) return "Not a directory or repo not found.";
        return data.map((f: any) =>
          `${f.type === "dir" ? "📁" : "📄"} ${f.name} ${f.type === "file" ? `(${formatSize(f.size)})` : ""}`
        ).join("\n");
      }

      case "gh_releases": {
        const count = (args.count as number) || 5;
        const data = await ghFetch(`/repos/${args.repo}/releases?per_page=${count}`);
        if (!data.length) return "No releases found.";
        return data.map((r: any) =>
          `${r.tag_name} — ${r.name || "(no title)"}\n  Published: ${r.published_at?.slice(0, 10)}\n  ${r.html_url}\n  Assets: ${r.assets?.length || 0}`
        ).join("\n\n");
      }

      case "gh_repo_info": {
        const data = await ghFetch(`/repos/${args.repo}`);
        return [
          `${data.full_name}`,
          `Description: ${data.description || "(none)"}`,
          `Stars: ${data.stargazers_count} | Forks: ${data.forks_count} | Issues: ${data.open_issues_count}`,
          `Language: ${data.language || "?"}`,
          `Created: ${data.created_at?.slice(0, 10)} | Updated: ${data.updated_at?.slice(0, 10)}`,
          `License: ${data.license?.spdx_id || "none"}`,
          `Topics: ${data.topics?.join(", ") || "none"}`,
          `URL: ${data.html_url}`,
          `Clone: ${data.clone_url}`,
          data.homepage ? `Homepage: ${data.homepage}` : "",
        ].filter(Boolean).join("\n");
      }

      case "gh_user": {
        const data = await ghFetch(`/users/${args.username}`);
        return [
          `${data.login} ${data.name ? `(${data.name})` : ""}`,
          `Type: ${data.type}`,
          `Bio: ${data.bio || "(none)"}`,
          `Repos: ${data.public_repos} | Gists: ${data.public_gists}`,
          `Followers: ${data.followers} | Following: ${data.following}`,
          `Created: ${data.created_at?.slice(0, 10)}`,
          `URL: ${data.html_url}`,
          data.blog ? `Blog: ${data.blog}` : "",
          data.company ? `Company: ${data.company}` : "",
          data.location ? `Location: ${data.location}` : "",
        ].filter(Boolean).join("\n");
      }

      case "gh_trending": {
        const lang = (args.language as string) || "";
        const since = (args.since as string) || "daily";
        const url = `https://github.com/trending/${lang}?since=${since}`;
        try {
          const res = await fetch(url, { headers: { "User-Agent": "Kate/1.0" }, signal: AbortSignal.timeout(10000) });
          const html = await res.text();
          const repos: string[] = [];
          const matches = html.matchAll(/href="\/([^"]+\/[^"]+)"[^>]*class="[^"]*text-bold[^"]*"/g);
          for (const m of matches) {
            if (repos.length >= 20) break;
            const name = m[1];
            if (!name.includes("/") || name.includes(".")) continue;
            repos.push(name);
          }
          if (repos.length === 0) return `No trending repos found for language: ${lang || "all"}`;
          return `Trending ${lang || "all languages"} (${since}):\n\n` + repos.map((r, i) =>
            `${i + 1}. ${r} — https://github.com/${r}`
          ).join("\n");
        } catch (err: any) {
          return `Error fetching trending: ${err.message}`;
        }
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default github;

