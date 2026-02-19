import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";

const port = Number(process.env.DASHBOARD_PORT || "8787");
const host = process.env.DASHBOARD_HOST || "127.0.0.1";
const statusPath = path.resolve(process.cwd(), process.env.RUNTIME_STATUS_PATH || "backtests/runtime-status.json");
const ideaPath = path.resolve(process.cwd(), process.env.IDEA_FACTORY_PATH || "backtests/idea-factory-latest.json");

const dashboardHtmlPath = path.resolve(process.cwd(), "src/dashboard/index.html");

const botCommand = process.env.DASHBOARD_BOT_CMD || "npm run dev";
const ideasCommand = process.env.DASHBOARD_IDEAS_CMD || "npm run ideas:build";
const scanCommand = process.env.DASHBOARD_SCAN_CMD || "npm run scan:btc:inefficiencies";
const phase1MonitorCommand = process.env.DASHBOARD_PHASE1_MONITOR_CMD || "npm run phase1:monitor";
const phase2IngestCommand = process.env.DASHBOARD_PHASE2_INGEST_CMD || "npm run phase2:ingest";
const reportsCommand = process.env.DASHBOARD_REPORTS_CMD || "npm run phase1:report && npm run phase2:report && npm run phase3:report";
const checkpointsCommand = process.env.DASHBOARD_CHECKPOINTS_CMD || "npm run validation:checkpoints";
const autopilotIntervalMs = Number(process.env.DASHBOARD_AUTOPILOT_INTERVAL_MS || "3600000");

type ProcKey = "bot" | "ideas" | "scan" | "phase1_monitor" | "phase2_ingest" | "reports" | "checkpoints";

interface ProcState {
  name: ProcKey;
  command: string;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  logs: string[];
  child: ChildProcess | null;
}

interface WorkflowState {
  simpleRunInFlight: boolean;
  autopilotEnabled: boolean;
  autopilotIntervalMs: number;
  nextAutopilotAt: string | null;
  lastCycleAt: string | null;
  lastCycleStatus: "idle" | "success" | "failed";
  lastCycleMessage: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readLatestValidationReports(): {
  phase1: Record<string, unknown> | null;
  phase2: Record<string, unknown> | null;
  phase3: Record<string, unknown> | null;
} {
  const dir = path.resolve(process.cwd(), "backtests", "validation-reports");
  if (!fs.existsSync(dir)) {
    return { phase1: null, phase2: null, phase3: null };
  }

  const files = fs.readdirSync(dir);
  const latestFor = (prefix: string): Record<string, unknown> | null => {
    const candidates = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
    if (candidates.length === 0) return null;
    const latest = candidates[candidates.length - 1];
    return readJson<Record<string, unknown>>(path.join(dir, latest));
  };

  return {
    phase1: latestFor("phase1-report-"),
    phase2: latestFor("phase2-report-"),
    phase3: latestFor("phase3-report-"),
  };
}

function sendJson(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: http.ServerResponse): void {
  if (!fs.existsSync(dashboardHtmlPath)) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Dashboard HTML missing: ${dashboardHtmlPath}`);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(dashboardHtmlPath, "utf8"));
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk || "");
      if (raw.length > 1024 * 1024) {
        raw = "";
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        resolve(parsed || {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

class ProcessController {
  private readonly procs: Record<ProcKey, ProcState> = {
    bot: {
      name: "bot",
      command: botCommand,
      running: false,
      pid: null,
      startedAt: null,
      endedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
      child: null,
    },
    ideas: {
      name: "ideas",
      command: ideasCommand,
      running: false,
      pid: null,
      startedAt: null,
      endedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
      child: null,
    },
    scan: {
      name: "scan",
      command: scanCommand,
      running: false,
      pid: null,
      startedAt: null,
      endedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
      child: null,
    },
    phase1_monitor: {
      name: "phase1_monitor",
      command: phase1MonitorCommand,
      running: false,
      pid: null,
      startedAt: null,
      endedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
      child: null,
    },
    phase2_ingest: {
      name: "phase2_ingest",
      command: phase2IngestCommand,
      running: false,
      pid: null,
      startedAt: null,
      endedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
      child: null,
    },
    reports: {
      name: "reports",
      command: reportsCommand,
      running: false,
      pid: null,
      startedAt: null,
      endedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
      child: null,
    },
    checkpoints: {
      name: "checkpoints",
      command: checkpointsCommand,
      running: false,
      pid: null,
      startedAt: null,
      endedAt: null,
      lastExitCode: null,
      lastError: null,
      logs: [],
      child: null,
    },
  };

  private workflow: WorkflowState = {
    simpleRunInFlight: false,
    autopilotEnabled: false,
    autopilotIntervalMs,
    nextAutopilotAt: null,
    lastCycleAt: null,
    lastCycleStatus: "idle",
    lastCycleMessage: "idle",
  };

  private autopilotTimer: ReturnType<typeof setInterval> | null = null;

  status() {
    return {
      processes: {
        bot: this.publicProc(this.procs.bot),
        ideas: this.publicProc(this.procs.ideas),
        scan: this.publicProc(this.procs.scan),
        phase1_monitor: this.publicProc(this.procs.phase1_monitor),
        phase2_ingest: this.publicProc(this.procs.phase2_ingest),
        reports: this.publicProc(this.procs.reports),
        checkpoints: this.publicProc(this.procs.checkpoints),
      },
      workflow: this.workflow,
      commands: {
        bot: this.procs.bot.command,
        ideas: this.procs.ideas.command,
        scan: this.procs.scan.command,
        phase1Monitor: this.procs.phase1_monitor.command,
        phase2Ingest: this.procs.phase2_ingest.command,
        reports: this.procs.reports.command,
        checkpoints: this.procs.checkpoints.command,
      },
    };
  }

  async runIdeas(): Promise<{ ok: boolean; message: string }> {
    if (this.procs.ideas.running) {
      return { ok: false, message: "ideas run already in progress" };
    }
    const result = await this.spawnOneShot("ideas");
    return result;
  }

  async runScan(): Promise<{ ok: boolean; message: string }> {
    if (this.procs.scan.running) {
      return { ok: false, message: "scan run already in progress" };
    }
    return this.spawnOneShot("scan");
  }

  startPhase1Monitor(): { ok: boolean; message: string } {
    if (this.procs.phase1_monitor.running) {
      return { ok: false, message: "phase1 monitor already running" };
    }
    this.spawnLongRunning("phase1_monitor");
    return { ok: true, message: "phase1 monitor started" };
  }

  async stopPhase1Monitor(): Promise<{ ok: boolean; message: string }> {
    if (!this.procs.phase1_monitor.running) {
      return { ok: false, message: "phase1 monitor not running" };
    }
    await this.stopProc("phase1_monitor");
    return { ok: true, message: "phase1 monitor stopped" };
  }

  async runPhase2Ingest(): Promise<{ ok: boolean; message: string }> {
    if (this.procs.phase2_ingest.running) {
      return { ok: false, message: "phase2 ingest already in progress" };
    }
    return this.spawnOneShot("phase2_ingest");
  }

  async runReports(): Promise<{ ok: boolean; message: string }> {
    if (this.procs.reports.running) {
      return { ok: false, message: "reports already running" };
    }
    return this.spawnOneShot("reports");
  }

  async runCheckpoints(): Promise<{ ok: boolean; message: string }> {
    if (this.procs.checkpoints.running) {
      return { ok: false, message: "checkpoints already running" };
    }
    return this.spawnOneShot("checkpoints");
  }

  startBot(): { ok: boolean; message: string } {
    if (this.procs.bot.running) {
      return { ok: false, message: "bot already running" };
    }
    this.spawnLongRunning("bot");
    return { ok: true, message: "bot started" };
  }

  async stopBot(): Promise<{ ok: boolean; message: string }> {
    if (!this.procs.bot.running || !this.procs.bot.child) {
      return { ok: false, message: "bot not running" };
    }
    await this.stopProc("bot");
    return { ok: true, message: "bot stopped" };
  }

  async stopAll(): Promise<{ ok: boolean; message: string }> {
    await this.stopAutopilot();
    if (this.procs.bot.running) {
      await this.stopProc("bot");
    }
    if (this.procs.phase1_monitor.running) {
      await this.stopProc("phase1_monitor");
    }
    if (this.procs.ideas.running) {
      await this.stopProc("ideas");
    }
    if (this.procs.scan.running) {
      await this.stopProc("scan");
    }
    return { ok: true, message: "all workflows stopped" };
  }

  async runSimpleLaunch(): Promise<{ ok: boolean; message: string }> {
    if (this.workflow.simpleRunInFlight) {
      return { ok: false, message: "simple launch already in progress" };
    }

    this.workflow.simpleRunInFlight = true;
    this.workflow.lastCycleAt = nowIso();
    this.workflow.lastCycleStatus = "idle";
    this.workflow.lastCycleMessage = "starting simple launch";

    try {
      const scan = await this.runScan();
      if (!scan.ok) {
        this.workflow.lastCycleStatus = "failed";
        this.workflow.lastCycleMessage = `scan failed: ${scan.message}`;
        return { ok: false, message: `simple launch failed: ${scan.message}` };
      }

      const ideas = await this.runIdeas();
      if (!ideas.ok) {
        this.workflow.lastCycleStatus = "failed";
        this.workflow.lastCycleMessage = `ideas failed: ${ideas.message}`;
        return { ok: false, message: `simple launch failed: ${ideas.message}` };
      }

      const bot = this.startBot();
      if (!bot.ok) {
        this.workflow.lastCycleStatus = "failed";
        this.workflow.lastCycleMessage = `bot start failed: ${bot.message}`;
        return { ok: false, message: `simple launch failed: ${bot.message}` };
      }

      this.workflow.lastCycleStatus = "success";
      this.workflow.lastCycleMessage = "ideas build complete, bot running";
      return { ok: true, message: "simple launch completed" };
    } finally {
      this.workflow.simpleRunInFlight = false;
    }
  }

  startAutopilot(): { ok: boolean; message: string } {
    if (this.workflow.autopilotEnabled) {
      return { ok: false, message: "autopilot already enabled" };
    }

    this.workflow.autopilotEnabled = true;
    this.setNextAutopilotAt();

    this.autopilotTimer = setInterval(async () => {
      if (!this.workflow.autopilotEnabled) return;
      if (this.workflow.simpleRunInFlight || this.procs.ideas.running || this.procs.scan.running) return;

      this.workflow.lastCycleAt = nowIso();
      this.workflow.lastCycleStatus = "idle";
      this.workflow.lastCycleMessage = "autopilot cycle running";

      const scan = await this.runScan();
      if (!scan.ok) {
        this.workflow.lastCycleStatus = "failed";
        this.workflow.lastCycleMessage = `autopilot scan failed: ${scan.message}`;
        this.setNextAutopilotAt();
        return;
      }

      const ideas = await this.runIdeas();
      if (!ideas.ok) {
        this.workflow.lastCycleStatus = "failed";
        this.workflow.lastCycleMessage = `autopilot ideas failed: ${ideas.message}`;
        this.setNextAutopilotAt();
        return;
      }

      if (!this.procs.bot.running) {
        this.startBot();
      }

      this.workflow.lastCycleStatus = "success";
      this.workflow.lastCycleMessage = "autopilot cycle success";
      this.setNextAutopilotAt();
      await this.runCheckpoints();
    }, this.workflow.autopilotIntervalMs);

    return { ok: true, message: "autopilot enabled" };
  }

  async stopAutopilot(): Promise<{ ok: boolean; message: string }> {
    this.workflow.autopilotEnabled = false;
    this.workflow.nextAutopilotAt = null;
    if (this.autopilotTimer) {
      clearInterval(this.autopilotTimer);
      this.autopilotTimer = null;
    }
    return { ok: true, message: "autopilot disabled" };
  }

  private setNextAutopilotAt(): void {
    this.workflow.nextAutopilotAt = new Date(Date.now() + this.workflow.autopilotIntervalMs).toISOString();
  }

  private publicProc(proc: ProcState) {
    return {
      name: proc.name,
      command: proc.command,
      running: proc.running,
      pid: proc.pid,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      lastExitCode: proc.lastExitCode,
      lastError: proc.lastError,
      logs: proc.logs,
    };
  }

  private appendLog(key: ProcKey, line: string): void {
    const proc = this.procs[key];
    proc.logs.unshift(`${new Date().toISOString()} ${line}`);
    if (proc.logs.length > 400) {
      proc.logs = proc.logs.slice(0, 400);
    }
  }

  private spawnLongRunning(key: ProcKey): void {
    const proc = this.procs[key];
    const child = spawn(proc.command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.child = child;
    proc.running = true;
    proc.pid = child.pid ?? null;
    proc.startedAt = nowIso();
    proc.endedAt = null;
    proc.lastExitCode = null;
    proc.lastError = null;
    this.appendLog(key, `[start] ${proc.command}`);

    child.stdout?.on("data", (buf) => this.appendLog(key, String(buf).trimEnd()));
    child.stderr?.on("data", (buf) => this.appendLog(key, `[stderr] ${String(buf).trimEnd()}`));
    child.on("error", (err) => {
      proc.lastError = err.message;
      this.appendLog(key, `[error] ${err.message}`);
    });
    child.on("close", (code) => {
      proc.running = false;
      proc.pid = null;
      proc.child = null;
      proc.lastExitCode = code ?? null;
      proc.endedAt = nowIso();
      this.appendLog(key, `[exit] code=${code ?? "null"}`);
    });
  }

  private spawnOneShot(key: ProcKey): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const proc = this.procs[key];
      const child = spawn(proc.command, {
        cwd: process.cwd(),
        env: process.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.child = child;
      proc.running = true;
      proc.pid = child.pid ?? null;
      proc.startedAt = nowIso();
      proc.endedAt = null;
      proc.lastExitCode = null;
      proc.lastError = null;
      this.appendLog(key, `[start] ${proc.command}`);

      child.stdout?.on("data", (buf) => this.appendLog(key, String(buf).trimEnd()));
      child.stderr?.on("data", (buf) => this.appendLog(key, `[stderr] ${String(buf).trimEnd()}`));
      child.on("error", (err) => {
        proc.lastError = err.message;
        this.appendLog(key, `[error] ${err.message}`);
      });
      child.on("close", (code) => {
        proc.running = false;
        proc.pid = null;
        proc.child = null;
        proc.lastExitCode = code ?? null;
        proc.endedAt = nowIso();
        this.appendLog(key, `[exit] code=${code ?? "null"}`);

        if (code === 0) {
          resolve({ ok: true, message: `${key} completed` });
          return;
        }

        resolve({ ok: false, message: `${key} failed with code=${code ?? "null"}` });
      });
    });
  }

  private stopProc(key: ProcKey): Promise<void> {
    return new Promise((resolve) => {
      const proc = this.procs[key];
      const child = proc.child;
      if (!child) return resolve();

      this.appendLog(key, "[stop] SIGTERM");
      child.kill("SIGTERM");

      const timer = setTimeout(() => {
        if (proc.running && proc.child) {
          this.appendLog(key, "[stop] SIGKILL");
          proc.child.kill("SIGKILL");
        }
      }, 5000);

      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const controller = new ProcessController();

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    sendHtml(res);
    return;
  }

  if (req.method === "GET" && url === "/api/status") {
    const runtime = readJson<Record<string, unknown>>(statusPath);
    const idea = readJson<Record<string, unknown>>(ideaPath);
    const validation = readLatestValidationReports();
    sendJson(res, {
      ok: true,
      now: new Date().toISOString(),
      paths: { statusPath, ideaPath },
      runtime,
      idea,
      validation,
      control: controller.status(),
    });
    return;
  }

  if (req.method === "POST" && url === "/api/control") {
    const body = await parseBody(req);
    const action = String(body.action || "");

    let result: { ok: boolean; message: string } = { ok: false, message: "unknown action" };

    if (action === "run_scan") result = await controller.runScan();
    if (action === "start_phase1_monitor") result = controller.startPhase1Monitor();
    if (action === "stop_phase1_monitor") result = await controller.stopPhase1Monitor();
    if (action === "run_phase2_ingest") result = await controller.runPhase2Ingest();
    if (action === "run_reports") result = await controller.runReports();
    if (action === "run_checkpoints") result = await controller.runCheckpoints();
    if (action === "run_ideas") result = await controller.runIdeas();
    if (action === "start_bot") result = controller.startBot();
    if (action === "stop_bot") result = await controller.stopBot();
    if (action === "simple_launch") result = await controller.runSimpleLaunch();
    if (action === "start_autopilot") result = controller.startAutopilot();
    if (action === "stop_autopilot") result = await controller.stopAutopilot();
    if (action === "stop_all") result = await controller.stopAll();

    sendJson(res, { ok: result.ok, message: result.message, control: controller.status() });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

server.listen(port, host, () => {
  console.log(`Dashboard running on http://${host}:${port}`);
  console.log(`Reading runtime status from: ${statusPath}`);
  console.log(`Reading idea file from: ${ideaPath}`);
  console.log(`Control bot cmd: ${botCommand}`);
  console.log(`Control ideas cmd: ${ideasCommand}`);
  console.log(`Control scan cmd: ${scanCommand}`);
  console.log(`Control phase1 monitor cmd: ${phase1MonitorCommand}`);
  console.log(`Control phase2 ingest cmd: ${phase2IngestCommand}`);
  console.log(`Control reports cmd: ${reportsCommand}`);
  console.log(`Control checkpoints cmd: ${checkpointsCommand}`);
});
