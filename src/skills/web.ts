import type { Skill, SkillContext } from "../core/types.js";

const web: Skill = {
  id: "builtin.web",
  name: "Web",
  description: "Fetch web pages, make HTTP requests, and extract content from URLs",
  version: "1.0.0",
  tools: [
    {
      name: "fetch_url",
      description: "Fetch the contents of a web page or API endpoint",
      parameters: [
        { name: "url", type: "string", description: "The URL to fetch", required: true },
        { name: "method", type: "string", description: "HTTP method (default: GET)", required: false },
        { name: "headers", type: "object", description: "Custom headers", required: false },
        { name: "body", type: "string", description: "Request body (for POST/PUT)", required: false },
      ],
    },
    {
      name: "extract_text",
      description: "Fetch a web page and extract readable text content (strips HTML)",
      parameters: [
        { name: "url", type: "string", description: "The URL to extract text from", required: true },
      ],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "fetch_url": {
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const headers = (args.headers as Record<string, string>) || {};
        const body = args.body as string | undefined;

        try {
          const response = await fetch(url, {
            method,
            headers: { "User-Agent": "Kate/1.0", ...headers },
            body: method !== "GET" ? body : undefined,
          });

          const contentType = response.headers.get("content-type") || "";
          const text = await response.text();

          return [
            `Status: ${response.status} ${response.statusText}`,
            `Content-Type: ${contentType}`,
            `---`,
            text.slice(0, 20000),
          ].join("\n");
        } catch (err: any) {
          return `Fetch error: ${err.message}`;
        }
      }

      case "extract_text": {
        const url = args.url as string;
        try {
          const response = await fetch(url, {
            headers: { "User-Agent": "Kate/1.0" },
          });
          const html = await response.text();

          // Simple HTML to text extraction
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<nav[\s\S]*?<\/nav>/gi, "")
            .replace(/<footer[\s\S]*?<\/footer>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, " ")
            .trim();

          return text.slice(0, 20000) || "(no readable content)";
        } catch (err: any) {
          return `Error extracting text: ${err.message}`;
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },
};

export default web;

