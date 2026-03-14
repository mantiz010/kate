import type { Skill, SkillContext } from "../core/types.js";

let browser: any = null;
let page: any = null;

async function ensureBrowser(ctx: SkillContext) {
  if (browser && page) return { browser, page };

  try {
    const pw = await import("playwright");
    browser = await pw.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await browser.newContext({
      userAgent: "Kate/1.0 Browser Automation",
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    ctx.log.info("Browser launched");
    return { browser, page };
  } catch (err: any) {
    throw new Error(`Browser launch failed: ${err.message}. Install with: npx playwright install chromium`);
  }
}

const browserSkill: Skill = {
  id: "builtin.browser",
  name: "Browser",
  description: "Automate web browsing — navigate pages, click elements, fill forms, take screenshots, extract data",
  version: "1.0.0",
  tools: [
    {
      name: "browser_navigate",
      description: "Navigate to a URL and return the page title and text content",
      parameters: [
        { name: "url", type: "string", description: "URL to navigate to", required: true },
        { name: "waitFor", type: "string", description: "CSS selector to wait for before returning", required: false },
      ],
    },
    {
      name: "browser_click",
      description: "Click an element on the current page by CSS selector or text content",
      parameters: [
        { name: "selector", type: "string", description: "CSS selector or text to click (e.g. 'button.submit' or 'text=Sign In')", required: true },
      ],
    },
    {
      name: "browser_fill",
      description: "Type text into an input field",
      parameters: [
        { name: "selector", type: "string", description: "CSS selector of the input field", required: true },
        { name: "value", type: "string", description: "Text to type", required: true },
        { name: "pressEnter", type: "boolean", description: "Press Enter after typing", required: false },
      ],
    },
    {
      name: "browser_screenshot",
      description: "Take a screenshot of the current page and save it to a file",
      parameters: [
        { name: "path", type: "string", description: "File path to save screenshot (default: ~/screenshot.png)", required: false },
        { name: "selector", type: "string", description: "CSS selector to screenshot a specific element", required: false },
        { name: "fullPage", type: "boolean", description: "Capture full scrollable page", required: false },
      ],
    },
    {
      name: "browser_extract",
      description: "Extract text content, links, or structured data from the current page",
      parameters: [
        { name: "selector", type: "string", description: "CSS selector to extract from (default: body)", required: false },
        { name: "attribute", type: "string", description: "HTML attribute to extract (e.g. 'href', 'src')", required: false },
        { name: "all", type: "boolean", description: "Extract from all matching elements (default: first only)", required: false },
      ],
    },
    {
      name: "browser_eval",
      description: "Execute JavaScript in the browser context and return the result",
      parameters: [
        { name: "script", type: "string", description: "JavaScript to execute in the browser", required: true },
      ],
    },
    {
      name: "browser_wait",
      description: "Wait for a condition on the page",
      parameters: [
        { name: "selector", type: "string", description: "CSS selector to wait for", required: false },
        { name: "timeout", type: "number", description: "Max wait time in ms (default: 10000)", required: false },
        { name: "state", type: "string", description: "State to wait for: visible, hidden, attached, detached", required: false },
      ],
    },
    {
      name: "browser_scroll",
      description: "Scroll the page",
      parameters: [
        { name: "direction", type: "string", description: "up, down, top, bottom", required: true },
        { name: "amount", type: "number", description: "Pixels to scroll (default: 500)", required: false },
      ],
    },
    {
      name: "browser_tabs",
      description: "Manage browser tabs: list, switch, open new, close",
      parameters: [
        { name: "action", type: "string", description: "list, new, close, switch", required: true },
        { name: "url", type: "string", description: "URL for new tab", required: false },
        { name: "index", type: "number", description: "Tab index to switch to", required: false },
      ],
    },
    {
      name: "browser_close",
      description: "Close the browser instance to free resources",
      parameters: [],
    },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    switch (toolName) {
      case "browser_navigate": {
        const { page: p } = await ensureBrowser(ctx);
        const url = args.url as string;
        const waitFor = args.waitFor as string | undefined;

        try {
          await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          if (waitFor) await p.waitForSelector(waitFor, { timeout: 10000 });

          const title = await p.title();
          const text = await p.evaluate(() => {
            const el = document.querySelector("main") || document.querySelector("article") || document.body;
            return el?.innerText?.slice(0, 8000) || "(empty page)";
          });

          return `Navigated to: ${url}\nTitle: ${title}\nURL: ${p.url()}\n\nContent:\n${text}`;
        } catch (err: any) {
          return `Navigation error: ${err.message}`;
        }
      }

      case "browser_click": {
        const { page: p } = await ensureBrowser(ctx);
        const selector = args.selector as string;
        try {
          if (selector.startsWith("text=")) {
            await p.getByText(selector.slice(5)).first().click({ timeout: 5000 });
          } else {
            await p.click(selector, { timeout: 5000 });
          }
          await p.waitForLoadState("domcontentloaded").catch(() => {});
          return `Clicked: ${selector}\nCurrent URL: ${p.url()}`;
        } catch (err: any) {
          return `Click failed: ${err.message}`;
        }
      }

      case "browser_fill": {
        const { page: p } = await ensureBrowser(ctx);
        const selector = args.selector as string;
        const value = args.value as string;
        const pressEnter = args.pressEnter as boolean || false;
        try {
          await p.fill(selector, value, { timeout: 5000 });
          if (pressEnter) await p.press(selector, "Enter");
          return `Filled "${selector}" with "${value}"${pressEnter ? " + Enter" : ""}`;
        } catch (err: any) {
          return `Fill failed: ${err.message}`;
        }
      }

      case "browser_screenshot": {
        const { page: p } = await ensureBrowser(ctx);
        const filePath = (args.path as string) || `${process.env.HOME || "/tmp"}/screenshot.png`;
        const selector = args.selector as string | undefined;
        const fullPage = args.fullPage as boolean || false;
        try {
          if (selector) {
            const el = await p.$(selector);
            if (el) await el.screenshot({ path: filePath });
            else return `Element not found: ${selector}`;
          } else {
            await p.screenshot({ path: filePath, fullPage });
          }
          return `Screenshot saved: ${filePath}`;
        } catch (err: any) {
          return `Screenshot failed: ${err.message}`;
        }
      }

      case "browser_extract": {
        const { page: p } = await ensureBrowser(ctx);
        const selector = (args.selector as string) || "body";
        const attribute = args.attribute as string | undefined;
        const all = args.all as boolean || false;
        try {
          if (all) {
            const results = await p.$$eval(selector, (els: Element[], attr: string | undefined) => {
              return els.slice(0, 50).map(el => {
                if (attr) return el.getAttribute(attr) || "";
                return (el as HTMLElement).innerText?.slice(0, 500) || el.textContent?.slice(0, 500) || "";
              });
            }, attribute);
            return results.filter(Boolean).join("\n---\n") || "(no results)";
          } else {
            const result = await p.$eval(selector, (el: Element, attr: string | undefined) => {
              if (attr) return el.getAttribute(attr) || "";
              return (el as HTMLElement).innerText?.slice(0, 5000) || el.textContent?.slice(0, 5000) || "";
            }, attribute);
            return result || "(empty)";
          }
        } catch (err: any) {
          return `Extract failed: ${err.message}`;
        }
      }

      case "browser_eval": {
        const { page: p } = await ensureBrowser(ctx);
        const script = args.script as string;
        try {
          const result = await p.evaluate(script);
          return typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);
        } catch (err: any) {
          return `Eval error: ${err.message}`;
        }
      }

      case "browser_wait": {
        const { page: p } = await ensureBrowser(ctx);
        const selector = args.selector as string | undefined;
        const timeout = (args.timeout as number) || 10000;
        const state = (args.state as string) || "visible";
        try {
          if (selector) {
            await p.waitForSelector(selector, { timeout, state });
            return `Element "${selector}" is ${state}`;
          } else {
            await p.waitForTimeout(timeout);
            return `Waited ${timeout}ms`;
          }
        } catch (err: any) {
          return `Wait timeout: ${err.message}`;
        }
      }

      case "browser_scroll": {
        const { page: p } = await ensureBrowser(ctx);
        const direction = args.direction as string;
        const amount = (args.amount as number) || 500;
        try {
          switch (direction) {
            case "down": await p.evaluate((px: number) => window.scrollBy(0, px), amount); break;
            case "up": await p.evaluate((px: number) => window.scrollBy(0, -px), amount); break;
            case "top": await p.evaluate(() => window.scrollTo(0, 0)); break;
            case "bottom": await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); break;
          }
          return `Scrolled ${direction}`;
        } catch (err: any) {
          return `Scroll failed: ${err.message}`;
        }
      }

      case "browser_tabs": {
        const { browser: b } = await ensureBrowser(ctx);
        const action = args.action as string;
        const context = b.contexts()[0];
        const pages = context.pages();

        switch (action) {
          case "list":
            return pages.map((p: any, i: number) =>
              `[${i}] ${p.url()} — ${p === page ? "(active)" : ""}`
            ).join("\n");
          case "new": {
            const newPage = await context.newPage();
            if (args.url) await newPage.goto(args.url as string);
            page = newPage;
            return `Opened new tab${args.url ? `: ${args.url}` : ""}`;
          }
          case "close":
            if (pages.length <= 1) return "Can't close the last tab";
            await page.close();
            page = pages.find((p: any) => p !== page) || pages[0];
            return "Tab closed";
          case "switch": {
            const idx = args.index as number || 0;
            if (idx >= 0 && idx < pages.length) {
              page = pages[idx];
              return `Switched to tab ${idx}: ${page.url()}`;
            }
            return `Invalid tab index: ${idx}`;
          }
          default:
            return `Unknown tab action: ${action}`;
        }
      }

      case "browser_close": {
        if (browser) {
          await browser.close();
          browser = null;
          page = null;
          return "Browser closed";
        }
        return "No browser open";
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  },

  async onUnload() {
    if (browser) {
      await browser.close();
      browser = null;
      page = null;
    }
  },
};

export default browserSkill;

