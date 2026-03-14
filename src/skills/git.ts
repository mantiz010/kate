import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execAsync = promisify(exec);
const run = async (cmd: string, cwd?: string) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 * 5 });
    return stdout || stderr || "(no output)";
  } catch (err: any) {
    return `Error: ${err.stderr || err.message}`;
  }
};

const git: Skill = {
  id: "builtin.git",
  name: "Git & GitHub",
  description: "Full git workflow: clone, commit, branch, merge, push, pull requests, issues, code review, diff analysis",
  version: "1.0.0",
  tools: [
    { name: "git_status", description: "Show git status of a repo", parameters: [
      { name: "path", type: "string", description: "Repo path (default: cwd)", required: false },
    ]},
    { name: "git_log", description: "Show recent commit history", parameters: [
      { name: "path", type: "string", description: "Repo path", required: false },
      { name: "count", type: "number", description: "Number of commits (default: 10)", required: false },
    ]},
    { name: "git_diff", description: "Show current changes or diff between refs", parameters: [
      { name: "path", type: "string", description: "Repo path", required: false },
      { name: "ref", type: "string", description: "Ref to diff against (e.g. HEAD~1, main)", required: false },
      { name: "file", type: "string", description: "Specific file to diff", required: false },
    ]},
    { name: "git_clone", description: "Clone a repository", parameters: [
      { name: "url", type: "string", description: "Repository URL", required: true },
      { name: "path", type: "string", description: "Destination path", required: false },
    ]},
    { name: "git_commit", description: "Stage all changes and commit with a message", parameters: [
      { name: "message", type: "string", description: "Commit message", required: true },
      { name: "path", type: "string", description: "Repo path", required: false },
      { name: "files", type: "string", description: "Specific files to stage (comma-separated, default: all)", required: false },
    ]},
    { name: "git_push", description: "Push commits to remote", parameters: [
      { name: "path", type: "string", description: "Repo path", required: false },
      { name: "branch", type: "string", description: "Branch to push", required: false },
      { name: "force", type: "boolean", description: "Force push", required: false },
    ]},
    { name: "git_pull", description: "Pull latest from remote", parameters: [
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "git_branch", description: "Create, list, switch, or delete branches", parameters: [
      { name: "action", type: "string", description: "list, create, switch, delete", required: true },
      { name: "name", type: "string", description: "Branch name (for create/switch/delete)", required: false },
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "git_merge", description: "Merge a branch into current", parameters: [
      { name: "branch", type: "string", description: "Branch to merge", required: true },
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "git_stash", description: "Stash or pop changes", parameters: [
      { name: "action", type: "string", description: "push, pop, list, drop", required: true },
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "gh_pr_create", description: "Create a GitHub pull request (requires gh CLI)", parameters: [
      { name: "title", type: "string", description: "PR title", required: true },
      { name: "body", type: "string", description: "PR description", required: false },
      { name: "base", type: "string", description: "Base branch (default: main)", required: false },
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "gh_pr_list", description: "List open pull requests", parameters: [
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "gh_issue_create", description: "Create a GitHub issue", parameters: [
      { name: "title", type: "string", description: "Issue title", required: true },
      { name: "body", type: "string", description: "Issue body", required: false },
      { name: "labels", type: "string", description: "Comma-separated labels", required: false },
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "gh_issue_list", description: "List open issues", parameters: [
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
    { name: "git_blame", description: "Show who changed each line of a file", parameters: [
      { name: "file", type: "string", description: "File path", required: true },
      { name: "path", type: "string", description: "Repo path", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const cwd = (args.path as string) || process.cwd();

    switch (toolName) {
      case "git_status": return run("git status --short --branch", cwd);
      case "git_log": {
        const n = (args.count as number) || 10;
        return run(`git log --oneline --graph --decorate -${n}`, cwd);
      }
      case "git_diff": {
        const ref = (args.ref as string) || "";
        const file = (args.file as string) || "";
        return run(`git diff ${ref} -- ${file}`.trim(), cwd);
      }
      case "git_clone": {
        const dest = (args.path as string) || "";
        return run(`git clone ${args.url} ${dest}`.trim());
      }
      case "git_commit": {
        const files = (args.files as string) || ".";
        await run(`git add ${files}`, cwd);
        return run(`git commit -m "${(args.message as string).replace(/"/g, '\\"')}"`, cwd);
      }
      case "git_push": {
        const branch = (args.branch as string) || "";
        const force = (args.force as boolean) ? "--force" : "";
        return run(`git push ${force} origin ${branch}`.trim(), cwd);
      }
      case "git_pull": return run("git pull", cwd);
      case "git_branch": {
        const action = args.action as string;
        const name = args.name as string || "";
        switch (action) {
          case "list": return run("git branch -a", cwd);
          case "create": return run(`git checkout -b ${name}`, cwd);
          case "switch": return run(`git checkout ${name}`, cwd);
          case "delete": return run(`git branch -d ${name}`, cwd);
          default: return `Unknown action: ${action}`;
        }
      }
      case "git_merge": return run(`git merge ${args.branch}`, cwd);
      case "git_stash": {
        const action = args.action as string;
        return run(`git stash ${action}`, cwd);
      }
      case "gh_pr_create": {
        const base = (args.base as string) || "main";
        const body = (args.body as string) || "";
        return run(`gh pr create --title "${(args.title as string).replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base ${base}`, cwd);
      }
      case "gh_pr_list": return run("gh pr list", cwd);
      case "gh_issue_create": {
        const labels = (args.labels as string) ? `--label "${args.labels}"` : "";
        const body = (args.body as string) || "";
        return run(`gh issue create --title "${(args.title as string).replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" ${labels}`, cwd);
      }
      case "gh_issue_list": return run("gh issue list", cwd);
      case "git_blame": return run(`git blame ${args.file}`, cwd);
      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export default git;

