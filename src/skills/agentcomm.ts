import type { Skill, SkillContext } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createLogger("agentcomm");

// ── Message Bus ────────────────────────────────────────────────

interface AgentMessage {
  id: string;
  from: string;
  to: string;           // agent ID or "*" for broadcast
  channel: string;       // topic/channel name
  type: "request" | "response" | "broadcast" | "event";
  content: string;
  data?: Record<string, unknown>;
  timestamp: number;
  replyTo?: string;      // message ID this replies to
  ttl?: number;          // time-to-live in seconds
}

class MessageBus extends EventEmitter {
  private channels = new Map<string, Set<string>>();  // channel → subscriber IDs
  private messages: AgentMessage[] = [];
  private pending = new Map<string, (msg: AgentMessage) => void>();  // waiting for replies
  private inbox = new Map<string, AgentMessage[]>();  // per-agent inbox

  // Subscribe an agent to a channel
  subscribe(agentId: string, channel: string): void {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel)!.add(agentId);
    log.debug(`${agentId} subscribed to #${channel}`);
  }

  unsubscribe(agentId: string, channel: string): void {
    this.channels.get(channel)?.delete(agentId);
  }

  // Send a message
  send(msg: Omit<AgentMessage, "id" | "timestamp">): AgentMessage {
    const full: AgentMessage = {
      ...msg,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    };

    this.messages.push(full);
    if (this.messages.length > 500) this.messages.shift();

    // Deliver to specific agent
    if (full.to !== "*") {
      if (!this.inbox.has(full.to)) this.inbox.set(full.to, []);
      this.inbox.get(full.to)!.push(full);
      if (this.inbox.get(full.to)!.length > 100) this.inbox.get(full.to)!.shift();
    }

    // Deliver to channel subscribers
    if (full.channel) {
      const subs = this.channels.get(full.channel) || new Set();
      for (const sub of subs) {
        if (sub === full.from) continue;
        if (!this.inbox.has(sub)) this.inbox.set(sub, []);
        this.inbox.get(sub)!.push(full);
      }
    }

    // Check if this is a reply to a pending request
    if (full.replyTo && this.pending.has(full.replyTo)) {
      this.pending.get(full.replyTo)!(full);
      this.pending.delete(full.replyTo);
    }

    this.emit("message", full);
    log.debug(`Message: ${full.from} → ${full.to} [#${full.channel}] ${full.content.slice(0, 50)}`);

    return full;
  }

  // Send and wait for reply
  async request(msg: Omit<AgentMessage, "id" | "timestamp" | "type">, timeoutMs = 30000): Promise<AgentMessage | null> {
    return new Promise((resolve) => {
      const sent = this.send({ ...msg, type: "request" });
      const timer = setTimeout(() => {
        this.pending.delete(sent.id);
        resolve(null);
      }, timeoutMs);

      this.pending.set(sent.id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // Read inbox
  getInbox(agentId: string, limit = 20): AgentMessage[] {
    return (this.inbox.get(agentId) || []).slice(-limit);
  }

  clearInbox(agentId: string): void {
    this.inbox.set(agentId, []);
  }

  // Get channel list
  getChannels(): Array<{ name: string; subscribers: number }> {
    return [...this.channels.entries()].map(([name, subs]) => ({
      name, subscribers: subs.size,
    }));
  }

  // Get message history for a channel
  getHistory(channel: string, limit = 20): AgentMessage[] {
    return this.messages.filter(m => m.channel === channel).slice(-limit);
  }

  // Get all recent messages
  getRecent(limit = 30): AgentMessage[] {
    return this.messages.slice(-limit);
  }

  getStats(): { totalMessages: number; channels: number; agents: number } {
    const agents = new Set<string>();
    for (const subs of this.channels.values()) {
      for (const s of subs) agents.add(s);
    }
    return {
      totalMessages: this.messages.length,
      channels: this.channels.size,
      agents: agents.size,
    };
  }
}

// Singleton bus
const bus = new MessageBus();

const agentComm: Skill = {
  id: "builtin.agentcomm",
  name: "Agent Comms",
  description: "Agent-to-agent message bus. Workers can send messages, subscribe to channels, request/reply, and broadcast events to coordinate tasks.",
  version: "1.0.0",
  tools: [
    { name: "comm_send", description: "Send a message to another agent or broadcast to a channel", parameters: [
      { name: "to", type: "string", description: "Agent ID or '*' for broadcast", required: true },
      { name: "channel", type: "string", description: "Channel name (e.g. 'tasks', 'results', 'alerts')", required: true },
      { name: "content", type: "string", description: "Message content", required: true },
      { name: "data", type: "string", description: "Optional JSON data payload", required: false },
    ]},
    { name: "comm_subscribe", description: "Subscribe to a channel to receive messages", parameters: [
      { name: "channel", type: "string", description: "Channel to subscribe to", required: true },
    ]},
    { name: "comm_inbox", description: "Read messages in your inbox", parameters: [
      { name: "limit", type: "number", description: "Max messages (default: 10)", required: false },
    ]},
    { name: "comm_clear_inbox", description: "Clear your inbox", parameters: [] },
    { name: "comm_request", description: "Send a request to another agent and wait for a reply", parameters: [
      { name: "to", type: "string", description: "Target agent ID", required: true },
      { name: "channel", type: "string", description: "Channel", required: true },
      { name: "content", type: "string", description: "Request content", required: true },
      { name: "timeout", type: "number", description: "Timeout in seconds (default: 30)", required: false },
    ]},
    { name: "comm_reply", description: "Reply to a specific message", parameters: [
      { name: "messageId", type: "string", description: "ID of the message to reply to", required: true },
      { name: "content", type: "string", description: "Reply content", required: true },
    ]},
    { name: "comm_broadcast", description: "Broadcast a message to all agents on a channel", parameters: [
      { name: "channel", type: "string", description: "Channel to broadcast on", required: true },
      { name: "content", type: "string", description: "Message content", required: true },
    ]},
    { name: "comm_channels", description: "List all active channels and subscriber counts", parameters: [] },
    { name: "comm_history", description: "View message history for a channel", parameters: [
      { name: "channel", type: "string", description: "Channel name", required: true },
      { name: "limit", type: "number", description: "Max messages (default: 20)", required: false },
    ]},
    { name: "comm_stats", description: "Show message bus statistics", parameters: [] },
  ],

  async execute(toolName: string, args: Record<string, unknown>, ctx: SkillContext): Promise<string> {
    const myId = `${ctx.source}:${ctx.userId}`;

    switch (toolName) {
      case "comm_send": {
        let data: Record<string, unknown> | undefined;
        if (args.data) { try { data = JSON.parse(args.data as string); } catch {} }

        const msg = bus.send({
          from: myId,
          to: args.to as string,
          channel: args.channel as string,
          type: "broadcast",
          content: args.content as string,
          data,
        });
        return `Sent: ${msg.id} → ${args.to} on #${args.channel}`;
      }

      case "comm_subscribe": {
        bus.subscribe(myId, args.channel as string);
        return `Subscribed to #${args.channel}`;
      }

      case "comm_inbox": {
        const limit = (args.limit as number) || 10;
        const messages = bus.getInbox(myId, limit);
        if (messages.length === 0) return "Inbox empty.";
        return messages.map(m =>
          `[${m.id}] ${m.from} → #${m.channel} (${m.type})\n  ${m.content.slice(0, 200)}`
        ).join("\n\n");
      }

      case "comm_clear_inbox": {
        bus.clearInbox(myId);
        return "Inbox cleared.";
      }

      case "comm_request": {
        const timeout = ((args.timeout as number) || 30) * 1000;
        const reply = await bus.request({
          from: myId,
          to: args.to as string,
          channel: args.channel as string,
          content: args.content as string,
        }, timeout);

        return reply
          ? `Reply from ${reply.from}:\n${reply.content}`
          : `No reply received (timeout after ${timeout / 1000}s)`;
      }

      case "comm_reply": {
        const original = bus.getRecent(100).find(m => m.id === args.messageId);
        if (!original) return `Message ${args.messageId} not found.`;

        bus.send({
          from: myId,
          to: original.from,
          channel: original.channel,
          type: "response",
          content: args.content as string,
          replyTo: original.id,
        });
        return `Replied to ${original.id}`;
      }

      case "comm_broadcast": {
        bus.send({
          from: myId,
          to: "*",
          channel: args.channel as string,
          type: "broadcast",
          content: args.content as string,
        });
        return `Broadcast sent on #${args.channel}`;
      }

      case "comm_channels": {
        const channels = bus.getChannels();
        if (channels.length === 0) return "No active channels. Use comm_subscribe to create one.";
        return channels.map(c => `#${c.name} — ${c.subscribers} subscriber(s)`).join("\n");
      }

      case "comm_history": {
        const limit = (args.limit as number) || 20;
        const history = bus.getHistory(args.channel as string, limit);
        if (history.length === 0) return `No messages on #${args.channel}`;
        return history.map(m => {
          const time = new Date(m.timestamp).toLocaleTimeString();
          return `[${time}] ${m.from}: ${m.content.slice(0, 150)}`;
        }).join("\n");
      }

      case "comm_stats": {
        const stats = bus.getStats();
        return [
          "Message Bus Stats",
          `  Total messages: ${stats.totalMessages}`,
          `  Active channels: ${stats.channels}`,
          `  Connected agents: ${stats.agents}`,
        ].join("\n");
      }

      default: return `Unknown tool: ${toolName}`;
    }
  },
};

export { bus as messageBus };
export default agentComm;

