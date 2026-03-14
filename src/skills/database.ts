import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 30000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 * 10 });
    return (stdout || stderr || "(no output)").slice(0, 15000);
  } catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 5000); }
};

const CONNS_FILE = path.join(os.homedir(), ".aegis", "db-connections.json");
interface DBConn { name: string; type: "sqlite" | "postgres" | "mysql"; host?: string; port?: number; user?: string; pass?: string; database: string; }
let conns: DBConn[] = [];
function loadConns() { try { if (fs.existsSync(CONNS_FILE)) conns = JSON.parse(fs.readFileSync(CONNS_FILE, "utf-8")); } catch {} }
function saveConns() { const d = path.dirname(CONNS_FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(CONNS_FILE, JSON.stringify(conns, null, 2)); }

const database: Skill = {
  id: "builtin.database",
  name: "Database",
  description: "Query SQLite, PostgreSQL, and MySQL databases. Save connections, run SQL, export data, show schemas.",
  version: "1.0.0",
  tools: [
    { name: "db_query", description: "Run a SQL query on a database", parameters: [
      { name: "connection", type: "string", description: "Saved connection name, or SQLite file path", required: true },
      { name: "sql", type: "string", description: "SQL query to execute", required: true },
    ]},
    { name: "db_tables", description: "List all tables in a database", parameters: [
      { name: "connection", type: "string", description: "Connection name or SQLite path", required: true },
    ]},
    { name: "db_schema", description: "Show schema/structure of a table", parameters: [
      { name: "connection", type: "string", description: "Connection name or SQLite path", required: true },
      { name: "table", type: "string", description: "Table name", required: true },
    ]},
    { name: "db_save_connection", description: "Save a database connection for quick access", parameters: [
      { name: "name", type: "string", description: "Connection name", required: true },
      { name: "type", type: "string", description: "sqlite, postgres, or mysql", required: true },
      { name: "database", type: "string", description: "Database name or SQLite file path", required: true },
      { name: "host", type: "string", description: "Host (for postgres/mysql)", required: false },
      { name: "port", type: "number", description: "Port", required: false },
      { name: "user", type: "string", description: "Username", required: false },
      { name: "pass", type: "string", description: "Password", required: false },
    ]},
    { name: "db_list_connections", description: "List saved database connections", parameters: [] },
    { name: "db_export", description: "Export query results to CSV", parameters: [
      { name: "connection", type: "string", description: "Connection name", required: true },
      { name: "sql", type: "string", description: "SQL query", required: true },
      { name: "output", type: "string", description: "Output CSV file path", required: true },
    ]},
    { name: "db_count", description: "Count rows in a table", parameters: [
      { name: "connection", type: "string", description: "Connection name", required: true },
      { name: "table", type: "string", description: "Table name", required: true },
    ]},
    { name: "db_backup", description: "Backup a database to a file", parameters: [
      { name: "connection", type: "string", description: "Connection name", required: true },
      { name: "output", type: "string", description: "Backup file path", required: true },
    ]},
  ],

  async onLoad() { loadConns(); },

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    loadConns();

    function resolve(name: string): DBConn {
      const saved = conns.find(c => c.name === name);
      if (saved) return saved;
      // Assume SQLite file path
      return { name, type: "sqlite", database: name.startsWith("~/") ? name.replace("~", os.homedir()) : name };
    }

    function buildCmd(conn: DBConn, sql: string, format?: string): string {
      switch (conn.type) {
        case "sqlite":
          const f = format === "csv" ? "-csv -header" : "-header -column";
          return `sqlite3 ${f} "${conn.database}" "${sql.replace(/"/g, '\\"')}"`;
        case "postgres": {
          const env = conn.pass ? `PGPASSWORD="${conn.pass}" ` : "";
          const host = conn.host ? `-h ${conn.host}` : "";
          const port = conn.port ? `-p ${conn.port}` : "";
          const user = conn.user ? `-U ${conn.user}` : "";
          return `${env}psql ${host} ${port} ${user} -d ${conn.database} -c "${sql.replace(/"/g, '\\"')}"`;
        }
        case "mysql": {
          const host = conn.host ? `-h ${conn.host}` : "";
          const port = conn.port ? `-P ${conn.port}` : "";
          const user = conn.user ? `-u ${conn.user}` : "";
          const pass = conn.pass ? `-p"${conn.pass}"` : "";
          return `mysql ${host} ${port} ${user} ${pass} ${conn.database} -e "${sql.replace(/"/g, '\\"')}"`;
        }
        default: return `echo "Unknown database type: ${conn.type}"`;
      }
    }

    switch (toolName) {
      case "db_query": {
        const conn = resolve(args.connection as string);
        return run(buildCmd(conn, args.sql as string));
      }
      case "db_tables": {
        const conn = resolve(args.connection as string);
        let sql: string;
        switch (conn.type) {
          case "sqlite": sql = ".tables"; return run(`sqlite3 "${conn.database}" "${sql}"`);
          case "postgres": sql = "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"; break;
          case "mysql": sql = "SHOW TABLES"; break;
          default: return "Unknown type";
        }
        return run(buildCmd(conn, sql));
      }
      case "db_schema": {
        const conn = resolve(args.connection as string);
        const table = args.table as string;
        let sql: string;
        switch (conn.type) {
          case "sqlite": return run(`sqlite3 "${conn.database}" ".schema ${table}"`);
          case "postgres": sql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='${table}'`; break;
          case "mysql": sql = `DESCRIBE ${table}`; break;
          default: return "Unknown type";
        }
        return run(buildCmd(conn, sql));
      }
      case "db_save_connection": {
        const conn: DBConn = {
          name: args.name as string, type: args.type as any, database: args.database as string,
          host: args.host as string, port: args.port as number, user: args.user as string, pass: args.pass as string,
        };
        conns = conns.filter(c => c.name !== conn.name);
        conns.push(conn);
        saveConns();
        return `Saved: ${conn.name} (${conn.type}://${conn.host || "local"}/${conn.database})`;
      }
      case "db_list_connections": {
        if (conns.length === 0) return "No saved connections.";
        return conns.map(c => `• ${c.name} — ${c.type}://${c.host || "local"}/${c.database}`).join("\n");
      }
      case "db_export": {
        const conn = resolve(args.connection as string);
        const output = (args.output as string).replace("~", os.homedir());
        const cmd = conn.type === "sqlite"
          ? `sqlite3 -csv -header "${conn.database}" "${(args.sql as string).replace(/"/g, '\\"')}" > "${output}"`
          : `${buildCmd(conn, args.sql as string)} > "${output}"`;
        await run(cmd);
        return fs.existsSync(output) ? `Exported: ${output} (${fs.statSync(output).size} bytes)` : "Export may have failed";
      }
      case "db_count": {
        const conn = resolve(args.connection as string);
        return run(buildCmd(conn, `SELECT COUNT(*) as count FROM ${args.table}`));
      }
      case "db_backup": {
        const conn = resolve(args.connection as string);
        const output = (args.output as string).replace("~", os.homedir());
        switch (conn.type) {
          case "sqlite": return run(`cp "${conn.database}" "${output}" && echo "Backed up to ${output}"`);
          case "postgres": return run(`pg_dump ${conn.user ? "-U " + conn.user : ""} ${conn.host ? "-h " + conn.host : ""} ${conn.database} > "${output}"`, 120000);
          case "mysql": return run(`mysqldump ${conn.user ? "-u " + conn.user : ""} ${conn.host ? "-h " + conn.host : ""} ${conn.database} > "${output}"`, 120000);
          default: return "Unknown type";
        }
      }
      default: return `Unknown: ${toolName}`;
    }
  },
};
export default database;

