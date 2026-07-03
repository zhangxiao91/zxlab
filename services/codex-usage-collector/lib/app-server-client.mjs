import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class AppServerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class AppServerClient extends EventEmitter {
  constructor({ command = "codex", timeoutMs = 8000 } = {}) {
    super();
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    if (this.child) return;
    this.child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stderr.resume();
    this.child.once("error", (error) => this.failAll(new AppServerError("APP_SERVER_UNAVAILABLE", error.message)));
    this.child.once("exit", () => this.failAll(new AppServerError("APP_SERVER_UNAVAILABLE", "Codex App Server stopped")));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    await this.request("initialize", {
      clientInfo: { name: "zxlab-status-collector", title: "ZXLab Status Collector", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const code = message.error.code === -32601 ? "METHOD_UNSUPPORTED" : "UPSTREAM_ERROR";
        pending.reject(new AppServerError(code, String(message.error.message || "App Server request failed")));
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === "account/rateLimits/updated") this.emit("rate-limits-updated", message.params);
  }

  request(method, params) {
    if (!this.child?.stdin.writable) return Promise.reject(new AppServerError("APP_SERVER_UNAVAILABLE", "Codex App Server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError("REQUEST_TIMEOUT", `${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  notify(method, params) {
    this.child?.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async readUsage() {
    const account = await this.request("account/read", { refreshToken: false });
    if (account?.requiresOpenaiAuth && !account?.account) {
      throw new AppServerError("CODEX_NOT_LOGGED_IN", "Codex is not logged in on the collector host");
    }
    const [rateLimits, usage] = await Promise.all([
      this.request("account/rateLimits/read"),
      this.request("account/usage/read"),
    ]);
    return { rateLimits, usage };
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child = undefined;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
