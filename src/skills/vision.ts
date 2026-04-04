import type { Skill, SkillContext } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const OLLAMA_BASE = "http://172.168.1.162:11434";
const VISION_MODEL = "llama3.2-vision";

// ── Ollama vision API helper ──────────────────────────────────

interface OllamaChatRequest {
  model: string;
  messages: { role: string; content: string; images?: string[] }[];
  stream: false;
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

async function ollamaVision(
  prompt: string,
  imageBase64: string | string[],
  model: string = VISION_MODEL,
): Promise<string> {
  const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];

  const body: OllamaChatRequest = {
    model,
    messages: [{ role: "user", content: prompt, images }],
    stream: false,
  };

  const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama vision request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as OllamaChatResponse;
  return data.message.content;
}

// ── Image reading helper ──────────────────────────────────────

function readImageAsBase64(imagePath: string): string {
  const resolved = path.resolve(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image file not found: ${resolved}`);
  }

  const stats = fs.statSync(resolved);
  if (stats.size > 50 * 1024 * 1024) {
    throw new Error(`Image file too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max 50MB.`);
  }

  const buffer = fs.readFileSync(resolved);
  return buffer.toString("base64");
}

// ── Skill definition ──────────────────────────────────────────

const visionSkill: Skill = {
  id: "builtin.vision",
  name: "Vision",
  description:
    "Image and vision capabilities using Ollama vision models. Analyze images, take screenshots, compare images, extract text (OCR), and inspect PCB photos/schematics.",
  version: "1.0.0",
  tools: [
    {
      name: "vision_analyze",
      description:
        "Analyze an image file using a vision model. Returns a detailed description or answers a specific question about the image.",
      parameters: [
        {
          name: "image_path",
          type: "string",
          description: "Absolute or relative path to the image file",
          required: true,
        },
        {
          name: "prompt",
          type: "string",
          description:
            "What to look for or ask about the image. Defaults to a general description if omitted.",
          required: false,
        },
      ],
    },
    {
      name: "vision_screenshot",
      description:
        "Take a screenshot of a URL (using a headless browser) or the current desktop. Saves the image and returns the file path.",
      parameters: [
        {
          name: "url",
          type: "string",
          description:
            "URL to screenshot. If omitted, captures the desktop instead.",
          required: false,
        },
        {
          name: "save_path",
          type: "string",
          description:
            "Where to save the screenshot. Defaults to /tmp/kate_screenshot_<timestamp>.png",
          required: false,
        },
      ],
    },
    {
      name: "vision_compare",
      description:
        "Compare two images side-by-side using a vision model. Identifies differences, similarities, or answers a specific comparison question.",
      parameters: [
        {
          name: "image1",
          type: "string",
          description: "Path to the first image",
          required: true,
        },
        {
          name: "image2",
          type: "string",
          description: "Path to the second image",
          required: true,
        },
        {
          name: "prompt",
          type: "string",
          description:
            "Specific comparison question. Defaults to identifying key differences.",
          required: false,
        },
      ],
    },
    {
      name: "vision_ocr",
      description:
        "Extract text from an image using a vision model. Works on photos of documents, screenshots, signs, handwriting, etc.",
      parameters: [
        {
          name: "image_path",
          type: "string",
          description: "Path to the image containing text",
          required: true,
        },
      ],
    },
    {
      name: "vision_describe_pcb",
      description:
        "Specialized analysis of a PCB photo or schematic. Identifies components, traces, potential issues, and provides electronics-specific insights.",
      parameters: [
        {
          name: "image_path",
          type: "string",
          description: "Path to the PCB photo or schematic image",
          required: true,
        },
      ],
    },
  ],

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: SkillContext,
  ): Promise<string> {
    switch (toolName) {
      // ── vision_analyze ────────────────────────────────────────
      case "vision_analyze": {
        const imagePath = args.image_path as string;
        if (!imagePath) return "Error: image_path is required.";

        const prompt =
          (args.prompt as string) ||
          "Describe this image in detail. Include any text, objects, colors, layout, and notable features.";

        try {
          const base64 = readImageAsBase64(imagePath);
          ctx.log.info(`Analyzing image: ${imagePath}`);
          const result = await ollamaVision(prompt, base64);
          return result;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.error(`vision_analyze failed: ${msg}`);
          return `Error analyzing image: ${msg}`;
        }
      }

      // ── vision_screenshot ─────────────────────────────────────
      case "vision_screenshot": {
        const url = args.url as string | undefined;
        const savePath =
          (args.save_path as string) ||
          `/tmp/kate_screenshot_${Date.now()}.png`;

        const saveDir = path.dirname(savePath);
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }

        try {
          if (url) {
            // Try multiple headless browser options
            let captured = false;
            const errors: string[] = [];

            // Attempt 1: Chromium/Chrome headless
            for (const browser of [
              "chromium-browser",
              "chromium",
              "google-chrome",
              "google-chrome-stable",
            ]) {
              if (captured) break;
              try {
                await execAsync(
                  `${browser} --headless --disable-gpu --no-sandbox --screenshot="${savePath}" --window-size=1920,1080 "${url}"`,
                  { timeout: 30000 },
                );
                captured = true;
              } catch {
                errors.push(`${browser} not available`);
              }
            }

            // Attempt 2: Firefox headless with screenshot
            if (!captured) {
              try {
                await execAsync(
                  `firefox --headless --screenshot "${savePath}" --window-size=1920,1080 "${url}"`,
                  { timeout: 30000 },
                );
                captured = true;
              } catch {
                errors.push("firefox not available");
              }
            }

            if (!captured) {
              return `Error: No headless browser found to capture URL. Tried: ${errors.join(", ")}. Install chromium or firefox.`;
            }
          } else {
            // Desktop screenshot
            let captured = false;

            // Try scrot (common on Linux)
            try {
              await execAsync(`scrot "${savePath}"`, { timeout: 10000 });
              captured = true;
            } catch {
              // Try import from ImageMagick
              try {
                await execAsync(`import -window root "${savePath}"`, {
                  timeout: 10000,
                });
                captured = true;
              } catch {
                // Try gnome-screenshot
                try {
                  await execAsync(
                    `gnome-screenshot -f "${savePath}"`,
                    { timeout: 10000 },
                  );
                  captured = true;
                } catch {
                  // Try xdg-based or maim
                  try {
                    await execAsync(`maim "${savePath}"`, { timeout: 10000 });
                    captured = true;
                  } catch {
                    // noop
                  }
                }
              }
            }

            if (!captured) {
              return "Error: No screenshot tool found. Install scrot, maim, imagemagick, or gnome-screenshot.";
            }
          }

          if (!fs.existsSync(savePath)) {
            return "Error: Screenshot command ran but output file was not created.";
          }

          const stats = fs.statSync(savePath);
          ctx.log.info(
            `Screenshot saved: ${savePath} (${(stats.size / 1024).toFixed(1)}KB)`,
          );
          return `Screenshot saved to: ${savePath} (${(stats.size / 1024).toFixed(1)}KB)`;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.error(`vision_screenshot failed: ${msg}`);
          return `Error taking screenshot: ${msg}`;
        }
      }

      // ── vision_compare ────────────────────────────────────────
      case "vision_compare": {
        const image1 = args.image1 as string;
        const image2 = args.image2 as string;
        if (!image1 || !image2) return "Error: both image1 and image2 are required.";

        const prompt =
          (args.prompt as string) ||
          "Compare these two images carefully. Describe the key differences and similarities between them. Be specific about what has changed.";

        try {
          const base64_1 = readImageAsBase64(image1);
          const base64_2 = readImageAsBase64(image2);
          ctx.log.info(`Comparing images: ${image1} vs ${image2}`);
          const result = await ollamaVision(prompt, [base64_1, base64_2]);
          return result;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.error(`vision_compare failed: ${msg}`);
          return `Error comparing images: ${msg}`;
        }
      }

      // ── vision_ocr ────────────────────────────────────────────
      case "vision_ocr": {
        const imagePath = args.image_path as string;
        if (!imagePath) return "Error: image_path is required.";

        const ocrPrompt = [
          "Extract ALL text visible in this image. Follow these rules:",
          "1. Reproduce the text exactly as it appears, preserving layout and line breaks where possible.",
          "2. If text is in columns or tables, maintain the structure.",
          "3. Include any headers, labels, captions, watermarks, or small print.",
          "4. If any text is partially obscured or unclear, indicate it with [unclear].",
          "5. Do not describe the image — only output the extracted text.",
        ].join("\n");

        try {
          const base64 = readImageAsBase64(imagePath);
          ctx.log.info(`OCR on image: ${imagePath}`);
          const result = await ollamaVision(ocrPrompt, base64);
          return result;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.error(`vision_ocr failed: ${msg}`);
          return `Error extracting text: ${msg}`;
        }
      }

      // ── vision_describe_pcb ───────────────────────────────────
      case "vision_describe_pcb": {
        const imagePath = args.image_path as string;
        if (!imagePath) return "Error: image_path is required.";

        const pcbPrompt = [
          "You are an expert electronics engineer analyzing a PCB (Printed Circuit Board) photo or schematic. Provide a detailed analysis:",
          "",
          "1. **Component Identification**: List all visible components (ICs, resistors, capacitors, connectors, etc.) with their reference designators if readable.",
          "2. **Board Layout**: Describe the overall layout, layer count estimate, and board dimensions if determinable.",
          "3. **Key Connections**: Identify major traces, bus lines, power rails, and signal paths.",
          "4. **ICs and Chips**: Identify any IC markings, manufacturer logos, or part numbers visible.",
          "5. **Connectors**: List all connectors (USB, headers, terminal blocks, etc.) and their likely purpose.",
          "6. **Power Section**: Describe the power supply section if visible (regulators, inductors, large capacitors).",
          "7. **Potential Issues**: Flag any visible issues — cold solder joints, burn marks, missing components, bridged pads, lifted traces.",
          "8. **Purpose Estimate**: Based on the components, estimate what this board is designed to do.",
          "",
          "Be precise and technical. Use standard electronics terminology.",
        ].join("\n");

        try {
          const base64 = readImageAsBase64(imagePath);
          ctx.log.info(`PCB analysis on image: ${imagePath}`);
          const result = await ollamaVision(pcbPrompt, base64);
          return result;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log.error(`vision_describe_pcb failed: ${msg}`);
          return `Error analyzing PCB image: ${msg}`;
        }
      }

      default:
        return `Unknown vision tool: ${toolName}`;
    }
  },
};

export default visionSkill;
