import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const COLLECTIONS_DIR = path.join(os.homedir(), ".aegis", "api-collections");

interface ApiRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

interface ApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  latency: number;
  size: number;
}

async function makeRequest(req: ApiRequest): Promise<ApiResponse> {
  const start = Date.now();
  const init: RequestInit = {
    method: req.method,
    headers: {
      "User-Agent": "Kate/1.0",
      ...(req.headers || {}),
    },
    signal: AbortSignal.timeout((req.timeout || 30) * 1000),
  };

  if (req.body && ["POST", "PUT", "PATCH"].includes(req.method.toUpperCase())) {
    init.body = req.body;
    if (!init.headers || !(init.headers as Record<string, string>)["Content-Type"]) {
      // Auto-detect JSON
      try { JSON.parse(req.body); (init.headers as Record<string, string>)["Content-Type"] = "application/json"; } catch {}
    }
  }

  const res = await fetch(req.url, init);
  const latency = Date.now() - start;
  const body = await res.text();

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => headers[k] = v);

  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    body,
    latency,
    size: body.length,
  };
}

function formatResponse(res: ApiResponse, verbose = false): string {
  const lines: string[] = [];
  lines.push(`${res.status} ${res.statusText} — ${res.latency}ms (${formatSize(res.size)})`);

  if (verbose) {
    lines.push("\nHeaders:");
    for (const [k, v] of Object.entries(res.headers)) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  lines.push("");

  // Try to pretty-print JSON
  try {
    const json = JSON.parse(res.body);
    lines.push(JSON.stringify(json, null, 2).slice(0, 10000));
  } catch {
    lines.push(res.body.slice(0, 10000));
  }

  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const apiTester: Skill = {
  id: "builtin.apitester",
  name: "API Tester",
  description: "Send HTTP requests like Postman — GET, POST, PUT, DELETE with headers, body, auth. Parse JSON responses, chain requests, save collections.",
  version: "1.0.0",
  tools: [
    { name: "api_get", description: "Send a GET request", parameters: [
      { name: "url", type: "string", description: "URL to request", required: true },
      { name: "headers", type: "string", description: "JSON object of headers", required: false },
      { name: "verbose", type: "boolean", description: "Show response headers", required: false },
    ]},
    { name: "api_post", description: "Send a POST request with JSON body", parameters: [
      { name: "url", type: "string", description: "URL to request", required: true },
      { name: "body", type: "string", description: "Request body (JSON string)", required: true },
      { name: "headers", type: "string", description: "JSON object of headers", required: false },
    ]},
    { name: "api_put", description: "Send a PUT request", parameters: [
      { name: "url", type: "string", description: "URL to request", required: true },
      { name: "body", type: "string", description: "Request body", required: true },
      { name: "headers", type: "string", description: "JSON object of headers", required: false },
    ]},
    { name: "api_delete", description: "Send a DELETE request", parameters: [
      { name: "url", type: "string", description: "URL to request", required: true },
      { name: "headers", type: "string", description: "JSON object of headers", required: false },
    ]},
    { name: "api_request", description: "Send any HTTP request with full control over method, headers, body, auth", parameters: [
      { name: "method", type: "string", description: "HTTP method", required: true },
      { name: "url", type: "string", description: "URL", required: true },
      { name: "headers", type: "string", description: "JSON object of headers", required: false },
      { name: "body", type: "string", description: "Request body", required: false },
      { name: "auth", type: "string", description: "Auth: 'bearer TOKEN' or 'basic USER:PASS'", required: false },
      { name: "timeout", type: "number", description: "Timeout in seconds (default: 30)", required: false },
    ]},
    { name: "api_chain", description: "Run a sequence of API requests where later requests can reference earlier results using {{step1.field}}", parameters: [
      { name: "steps", type: "string", description: "JSON array of request objects: [{name, method, url, body, extract}]. Extract maps variable names to JSONPath-like expressions.", required: true },
    ]},
    { name: "api_collection_save", description: "Save a request to a named collection for reuse", parameters: [
      { name: "collection", type: "string", description: "Collection name", required: true },
      { name: "name", type: "string", description: "Request name", required: true },
      { name: "method", type: "string", description: "HTTP method", required: true },
      { name: "url", type: "string", description: "URL", required: true },
      { name: "headers", type: "string", description: "Headers JSON", required: false },
      { name: "body", type: "string", description: "Body", required: false },
    ]},
    { name: "api_collection_run", description: "Run all requests in a saved collection", parameters: [
      { name: "collection", type: "string", description: "Collection name", required: true },
    ]},
    { name: "api_collection_list", description: "List saved API collections", parameters: [] },
    { name: "api_benchmark", description: "Benchmark an endpoint — send N requests and report stats", parameters: [
      { name: "url", type: "string", description: "URL to benchmark", required: true },
      { name: "count", type: "number", description: "Number of requests (default: 10)", required: false },
      { name: "method", type: "string", description: "HTTP method (default: GET)", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "api_get": {
        let headers: Record<string, string> = {};
        if (args.headers) try { headers = JSON.parse(args.headers as string); } catch {}
        const res = await makeRequest({ method: "GET", url: args.url as string, headers });
        return formatResponse(res, args.verbose as boolean);
      }

      case "api_post": {
        let headers: Record<string, string> = {};
        if (args.headers) try { headers = JSON.parse(args.headers as string); } catch {}
        const res = await makeRequest({ method: "POST", url: args.url as string, body: args.body as string, headers });
        return formatResponse(res);
      }

      case "api_put": {
        let headers: Record<string, string> = {};
        if (args.headers) try { headers = JSON.parse(args.headers as string); } catch {}
        const res = await makeRequest({ method: "PUT", url: args.url as string, body: args.body as string, headers });
        return formatResponse(res);
      }

      case "api_delete": {
        let headers: Record<string, string> = {};
        if (args.headers) try { headers = JSON.parse(args.headers as string); } catch {}
        const res = await makeRequest({ method: "DELETE", url: args.url as string, headers });
        return formatResponse(res);
      }

      case "api_request": {
        let headers: Record<string, string> = {};
        if (args.headers) try { headers = JSON.parse(args.headers as string); } catch {}

        // Handle auth
        if (args.auth) {
          const auth = args.auth as string;
          if (auth.toLowerCase().startsWith("bearer ")) {
            headers["Authorization"] = `Bearer ${auth.slice(7)}`;
          } else if (auth.toLowerCase().startsWith("basic ")) {
            const creds = auth.slice(6);
            headers["Authorization"] = `Basic ${Buffer.from(creds).toString("base64")}`;
          }
        }

        const res = await makeRequest({
          method: (args.method as string).toUpperCase(),
          url: args.url as string,
          headers,
          body: args.body as string,
          timeout: args.timeout as number,
        });
        return formatResponse(res, true);
      }

      case "api_chain": {
        let steps: any[];
        try { steps = JSON.parse(args.steps as string); } catch (e: any) { return "Invalid steps JSON: " + e.message; }

        const vars: Record<string, any> = {};
        const output: string[] = [];

        for (const step of steps) {
          const name = step.name || `step${steps.indexOf(step) + 1}`;

          // Substitute variables in URL and body
          let url = step.url as string;
          let body = step.body as string;

          for (const [varName, varVal] of Object.entries(vars)) {
            const placeholder = `{{${varName}}}`;
            if (url) url = url.replace(placeholder, String(varVal));
            if (body) body = body.replace(placeholder, String(varVal));
          }

          output.push(`─── ${name}: ${step.method} ${url} ───`);

          try {
            const res = await makeRequest({ method: step.method, url, body });
            output.push(`${res.status} ${res.statusText} (${res.latency}ms)`);

            // Extract variables from response
            if (step.extract && res.body) {
              try {
                const json = JSON.parse(res.body);
                for (const [varName, jsonPath] of Object.entries(step.extract as Record<string, string>)) {
                  const keys = jsonPath.split(".");
                  let val: any = json;
                  for (const k of keys) {
                    if (val && typeof val === "object") val = val[k];
                    else { val = undefined; break; }
                  }
                  vars[varName] = val;
                  output.push(`  → ${varName} = ${JSON.stringify(val)}`);
                }
              } catch {}
            }

            // Show response preview
            try {
              const json = JSON.parse(res.body);
              output.push(JSON.stringify(json, null, 2).slice(0, 1000));
            } catch {
              output.push(res.body.slice(0, 500));
            }
          } catch (err: any) {
            output.push(`ERROR: ${err.message}`);
          }
          output.push("");
        }

        return output.join("\n");
      }

      case "api_collection_save": {
        if (!fs.existsSync(COLLECTIONS_DIR)) fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
        const colName = (args.collection as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const colFile = path.join(COLLECTIONS_DIR, `${colName}.json`);

        let collection: any[] = [];
        if (fs.existsSync(colFile)) {
          try { collection = JSON.parse(fs.readFileSync(colFile, "utf-8")); } catch {}
        }

        collection.push({
          name: args.name,
          method: args.method,
          url: args.url,
          headers: args.headers,
          body: args.body,
          addedAt: Date.now(),
        });

        fs.writeFileSync(colFile, JSON.stringify(collection, null, 2));
        return `Saved "${args.name}" to collection "${colName}" (${collection.length} requests total)`;
      }

      case "api_collection_run": {
        const colName = (args.collection as string).toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const colFile = path.join(COLLECTIONS_DIR, `${colName}.json`);
        if (!fs.existsSync(colFile)) return `Collection not found: ${colName}`;

        const collection = JSON.parse(fs.readFileSync(colFile, "utf-8"));
        const output: string[] = [`Running collection: ${colName} (${collection.length} requests)\n`];

        for (const req of collection) {
          let headers: Record<string, string> = {};
          if (req.headers) try { headers = JSON.parse(req.headers); } catch {}

          output.push(`─── ${req.name}: ${req.method} ${req.url} ───`);
          try {
            const res = await makeRequest({ method: req.method, url: req.url, headers, body: req.body });
            output.push(`${res.status} ${res.statusText} — ${res.latency}ms`);
          } catch (err: any) {
            output.push(`ERROR: ${err.message}`);
          }
        }

        return output.join("\n");
      }

      case "api_collection_list": {
        if (!fs.existsSync(COLLECTIONS_DIR)) return "No collections.";
        const files = fs.readdirSync(COLLECTIONS_DIR).filter(f => f.endsWith(".json"));
        if (files.length === 0) return "No collections.";
        return files.map(f => {
          const data = JSON.parse(fs.readFileSync(path.join(COLLECTIONS_DIR, f), "utf-8"));
          return `• ${f.replace(".json", "")} (${data.length} requests)`;
        }).join("\n");
      }

      case "api_benchmark": {
        const url = args.url as string;
        const count = (args.count as number) || 10;
        const method = (args.method as string) || "GET";

        const latencies: number[] = [];
        let errors = 0;

        for (let i = 0; i < count; i++) {
          try {
            const res = await makeRequest({ method, url, timeout: 15 });
            latencies.push(res.latency);
          } catch {
            errors++;
          }
        }

        if (latencies.length === 0) return `All ${count} requests failed.`;

        latencies.sort((a, b) => a - b);
        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];

        return [
          `Benchmark: ${method} ${url}`,
          `Requests: ${count} (${errors} errors)`,
          ``,
          `Avg: ${avg.toFixed(0)}ms`,
          `Min: ${latencies[0]}ms`,
          `Max: ${latencies[latencies.length - 1]}ms`,
          `P50: ${p50}ms`,
          `P95: ${p95}ms`,
          `P99: ${p99}ms`,
          `RPS: ${(1000 / avg * latencies.length / count).toFixed(1)}`,
        ].join("\n");
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default apiTester;

