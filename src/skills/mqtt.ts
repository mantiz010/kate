import type { Skill, SkillContext } from "../core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const run = async (cmd: string, timeout = 15000) => {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 1024 * 1024 });
    return (stdout || stderr || "(no output)").slice(0, 8000);
  } catch (err: any) { return `Error: ${err.stderr || err.message}`.slice(0, 3000); }
};


const MQTT_DEFAULTS = {
  host: "172.168.1.8",
  port: 1883,
  user: "mantiz010",
  pass: "DavidCross010",
};

const mqtt: Skill = {
  id: "builtin.mqtt",
  name: "MQTT",
  description: "Publish and subscribe to MQTT topics. Control Home Assistant devices, monitor IoT sensors, send commands to Zigbee2MQTT.",
  version: "1.0.0",
  tools: [
    { name: "mqtt_publish", description: "Publish a message to an MQTT topic", parameters: [
      { name: "topic", type: "string", description: "MQTT topic (e.g. homeassistant/switch/office/set)", required: true },
      { name: "message", type: "string", description: "Message payload (string or JSON)", required: true },
      { name: "host", type: "string", description: "Broker host (default: localhost)", required: false },
      { name: "port", type: "number", description: "Broker port (default: 1883)", required: false },
      { name: "user", type: "string", description: "Username", required: false },
      { name: "pass", type: "string", description: "Password", required: false },
      { name: "retain", type: "boolean", description: "Retain message", required: false },
    ]},
    { name: "mqtt_subscribe", description: "Subscribe to a topic and read messages for a few seconds", parameters: [
      { name: "topic", type: "string", description: "Topic to subscribe (supports wildcards: # and +)", required: true },
      { name: "host", type: "string", description: "Broker host", required: false },
      { name: "port", type: "number", description: "Port", required: false },
      { name: "user", type: "string", description: "Username", required: false },
      { name: "pass", type: "string", description: "Password", required: false },
      { name: "duration", type: "number", description: "Listen duration in seconds (default: 5)", required: false },
    ]},
    { name: "mqtt_ha_set", description: "Set a Home Assistant entity state via MQTT", parameters: [
      { name: "entity", type: "string", description: "Entity ID (e.g. light.office, switch.fan)", required: true },
      { name: "state", type: "string", description: "State: ON, OFF, or JSON payload", required: true },
      { name: "host", type: "string", description: "HA MQTT broker host", required: false },
      { name: "user", type: "string", description: "MQTT user", required: false },
      { name: "pass", type: "string", description: "MQTT password", required: false },
    ]},
    { name: "mqtt_z2m_devices", description: "List Zigbee2MQTT devices", parameters: [
      { name: "host", type: "string", description: "MQTT broker host", required: false },
      { name: "user", type: "string", description: "Username", required: false },
      { name: "pass", type: "string", description: "Password", required: false },
    ]},
    { name: "mqtt_z2m_set", description: "Send a command to a Zigbee device via Zigbee2MQTT", parameters: [
      { name: "device", type: "string", description: "Device friendly name", required: true },
      { name: "payload", type: "string", description: "JSON payload (e.g. '{\"state\":\"ON\",\"brightness\":200}')", required: true },
      { name: "host", type: "string", description: "MQTT broker", required: false },
      { name: "user", type: "string", description: "Username", required: false },
      { name: "pass", type: "string", description: "Password", required: false },
    ]},
    { name: "mqtt_topics", description: "Discover active MQTT topics by listening to #", parameters: [
      { name: "host", type: "string", description: "Broker host", required: false },
      { name: "user", type: "string", description: "Username", required: false },
      { name: "pass", type: "string", description: "Password", required: false },
      { name: "duration", type: "number", description: "Listen seconds (default: 5)", required: false },
    ]},
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const host = (args.host as string) || "172.168.1.8";
    const port = (args.port as number) || 1883;
    const user = (args.user as string) || "mantiz010";
    const pass = (args.pass as string) || "DavidCross010";
    const auth = user ? `-u "${user}" -P "${pass}"` : "";

    switch (toolName) {
      case "mqtt_publish": {
        const cmd = `mosquitto_pub -h ${host} -p ${port} ${auth} -t "${args.topic}" -m '${args.message}'`;
        console.log("MQTT CMD:", cmd);
        const retain = (args.retain as boolean) ? "-r" : "";
        return run(`mosquitto_pub -h ${host} -p ${port} ${auth} -t "${args.topic}" -m '${args.message}' ${retain} 2>&1 || echo "Install: sudo apt install mosquitto-clients"`);
      }

      case "mqtt_subscribe": {
        const dur = (args.duration as number) || 5;
        return run(`timeout ${dur} mosquitto_sub -h ${host} -p ${port} ${auth} -t "${args.topic}" -v 2>&1 || echo "Install: sudo apt install mosquitto-clients"`, (dur + 3) * 1000);
      }

      case "mqtt_ha_set": {
        const entity = args.entity as string;
        const state = args.state as string;
        const domain = entity.split(".")[0];
        let topic: string;
        let payload: string;

        if (domain === "light" || domain === "switch" || domain === "fan") {
          topic = `homeassistant/${domain}/${entity.split(".")[1]}/set`;
          payload = state.startsWith("{") ? state : `{"state":"${state}"}`;
        } else {
          topic = `homeassistant/${domain}/${entity.split(".")[1]}/set`;
          payload = state;
        }

        return run(`mosquitto_pub -h ${host} -p ${port} ${auth} -t "${topic}" -m '${payload}' 2>&1 && echo "Sent: ${topic} = ${payload}"`);
      }

      case "mqtt_z2m_devices": {
        // Request device list from Z2M
        const result = await run(`timeout 3 mosquitto_sub -h ${host} -p ${port} ${auth} -t "zigbee2mqtt/bridge/devices" -C 1 2>&1`, 5000);
        if (result.includes("Error") || result.includes("Install")) {
          return result;
        }
        try {
          const devices = JSON.parse(result);
          if (Array.isArray(devices)) {
            return devices.map((d: any) =>
              `• ${d.friendly_name || "?"} (${d.type || "?"}) — ${d.model || "?"} ${d.manufacturer || ""}`
            ).join("\n");
          }
        } catch {}
        return result;
      }

      case "mqtt_z2m_set": {
        const topic = `zigbee2mqtt/${args.device}/set`;
        return run(`mosquitto_pub -h ${host} -p ${port} ${auth} -t "${topic}" -m '${args.payload}' 2>&1 && echo "Sent: ${topic} = ${args.payload}"`);
      }

      case "mqtt_topics": {
        const dur = (args.duration as number) || 5;
        const result = await run(`timeout ${dur} mosquitto_sub -h ${host} -p ${port} ${auth} -t "#" -v 2>&1`, (dur + 3) * 1000);
        // Extract unique topics
        const topics = new Set<string>();
        for (const line of result.split("\n")) {
          const topic = line.split(" ")[0];
          if (topic && !topic.includes("Error")) topics.add(topic);
        }
        return `Active topics (${topics.size}):\n${[...topics].sort().join("\n")}`;
      }

      default: return `Unknown: ${toolName}`;
    }
  },
};
export default mqtt;

