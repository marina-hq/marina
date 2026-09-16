import { randomUUID } from "node:crypto";
import { cronMatches } from "./cron.ts";
import type { DevManifest } from "./manifest.ts";

/** In-process `marina.jobs`: enqueue runs the app's own handler through the
 * same job-execution request production uses, on this machine, immediately.
 * Schedules fire from a local timer only when --schedules is set. */

// Keep the local job endpoint aligned with the embedded runtime contract.
const JOB_EXECUTION_PATH = "/.marina/runtime/jobs/execute";

export interface DevJobStatus {
  id: string;
  name: string;
  state: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

type PlatformFetch = (request: Request) => Promise<Response>;

export class DevJobRunner {
  private readonly runs = new Map<string, DevJobStatus>();
  private readonly deduped = new Map<string, string>();
  private readonly token = randomUUID();
  private fetchApp: PlatformFetch | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScheduledMinute = "";

  private readonly manifest: DevManifest;
  private readonly identity: { workspaceId: string; appId: string };
  private readonly log: (line: string) => void;

  constructor(
    manifest: DevManifest,
    identity: { workspaceId: string; appId: string },
    log: (line: string) => void,
  ) {
    this.manifest = manifest;
    this.identity = identity;
    this.log = log;
  }

  attachApp(fetchApp: PlatformFetch): void {
    this.fetchApp = fetchApp;
  }

  authorizeJob(request: { token: string; body: string }): boolean {
    void request.body;
    return request.token === this.token;
  }

  enqueue(input: { name: string; input: unknown; dedupeKey?: string }): DevJobStatus {
    const definition = this.manifest.jobs[input.name];
    if (!definition) {
      throw new Error(`job "${input.name}" is not defined in marina.json`);
    }
    if (input.dedupeKey) {
      const existing = this.deduped.get(`${input.name}:${input.dedupeKey}`);
      const run = existing ? this.runs.get(existing) : undefined;
      if (run && (run.state === "queued" || run.state === "running")) return run;
    }
    const status: DevJobStatus = {
      id: randomUUID(),
      name: input.name,
      state: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.runs.set(status.id, status);
    if (input.dedupeKey) this.deduped.set(`${input.name}:${input.dedupeKey}`, status.id);
    void this.execute(status, definition.handler, input.input, "enqueue");
    return { ...status };
  }

  get(id: string): DevJobStatus | null {
    const run = this.runs.get(id);
    return run ? { ...run } : null;
  }

  private async execute(
    status: DevJobStatus,
    handler: string,
    input: unknown,
    trigger: "enqueue" | "schedule",
    scheduledFor?: string,
  ): Promise<void> {
    const fetchApp = this.fetchApp;
    if (!fetchApp) {
      status.state = "failed";
      status.finishedAt = new Date().toISOString();
      return;
    }
    status.state = "running";
    status.attempts += 1;
    status.startedAt = new Date().toISOString();
    const invocation = {
      runId: status.id,
      workspaceId: this.identity.workspaceId,
      appId: this.identity.appId,
      artifactDigest: `sha256:${"0".repeat(64)}`,
      environment: "development",
      jobName: status.name,
      handler,
      input,
      attempt: status.attempts,
      trigger,
      ...(scheduledFor ? { scheduledFor } : {}),
      connectionSession: "marina-local-dev",
    };
    try {
      const response = await fetchApp(
        new Request(`http://marina.dev.local${JOB_EXECUTION_PATH}`, {
          method: "POST",
          headers: { "x-marina-job-token": this.token, "content-type": "application/json" },
          body: JSON.stringify(invocation),
        }),
      );
      status.state = response.ok ? "succeeded" : "failed";
      if (!response.ok) {
        this.log(`job ${status.name} failed (${String(response.status)})`);
      }
    } catch (error) {
      status.state = "failed";
      this.log(`job ${status.name} threw: ${(error as Error).message}`);
    }
    status.finishedAt = new Date().toISOString();
  }

  startSchedules(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = new Date();
      const minute = now.toISOString().slice(0, 16);
      if (minute === this.lastScheduledMinute) return;
      this.lastScheduledMinute = minute;
      for (const [name, definition] of Object.entries(this.manifest.jobs)) {
        if (definition.schedule && cronMatches(definition.schedule, now)) {
          this.log(`schedule fired: ${name}`);
          try {
            const status = this.enqueue({ name, input: {} });
            const run = this.runs.get(status.id);
            if (run) run.state = run.state === "queued" ? "queued" : run.state;
          } catch (error) {
            this.log(`schedule ${name} failed to enqueue: ${(error as Error).message}`);
          }
        }
      }
    }, 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
