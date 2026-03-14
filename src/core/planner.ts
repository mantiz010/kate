import { createLogger } from "./logger.js";

const log = createLogger("planner");

export interface Plan {
  goal: string;
  steps: Array<{ action: string; tool?: string; depends?: number[] }>;
  reasoning: string;
}

// Detect if a message needs planning (complex multi-step task)
export function needsPlan(message: string): boolean {
  const msg = message.toLowerCase();
  const complexIndicators = [
    /and then|after that|once .* done/,
    /step[s]? \d|first .* then/,
    /create .* and .* and/,
    /design .* build .* deploy/,
    /scan .* fix .* report/,
    /clone .* analyze .* modify/,
    /set up .* configure .* test/,
    /compare .* with/,
    /for each|every/,
  ];
  return complexIndicators.some(p => p.test(msg));
}

// Generate a plan prompt that tells the model to think before acting
export function buildPlanPrompt(message: string): string {
  return `PLAN FIRST. This is a complex task. Before using any tools:
1. Break the task into numbered steps
2. Identify which tool to use for each step
3. Note any dependencies (step 3 needs output from step 1)
4. Then execute step by step

Task: ${message}

Think through the steps, then execute them one at a time.`;
}

// Parse steps from model output for logging
export function extractSteps(text: string): string[] {
  const steps: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*\d+[\.\)]\s*(.+)/);
    if (m) steps.push(m[1].trim());
  }
  return steps;
}
