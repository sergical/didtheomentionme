import type { WorkflowStep, WorkflowStepConfig, WorkflowStepContext, WorkflowTimeoutDuration } from "cloudflare:workers";
import { Effect, Tracer } from "effect";
import type { Env } from "./env";
import { runApp, span, type App } from "./runtime";
import { Telemetry, randomSpanId, workflowRootSpanId, workflowTraceId, type Attributes } from "./telemetry";

type Parent = { traceId: string; spanId: string };

/**
 * Durable steps whose bodies are Effects. A Workflow replays its `run` code after each restart, so only step bodies,
 * which run once, make spans and logs. A step ends only after its telemetry is sent: Workflows does not wait for
 * `waitUntil` work, and in production that lost the spans each step ends last. A span that covers several steps, like a phase or the whole run, is written
 * by its last step with the id and start time its first step saved.
 */
export class Steps {
  private constructor(
    private readonly env: Env,
    private readonly step: WorkflowStep,
    readonly parent: Parent,
  ) {}

  static async start(env: Env, step: WorkflowStep, instanceId: string): Promise<Steps> {
    return new Steps(env, step, { traceId: await workflowTraceId(instanceId), spanId: await workflowRootSpanId(instanceId) });
  }

  private under(parent: Parent) {
    return new Steps(this.env, this.step, parent);
  }

  /** One step. Its Effect span has the phase as its parent, which a Worker restart keeps. */
  do<A extends Rpc.Serializable<A>>(name: string, config: WorkflowStepConfig, body: Effect.Effect<A, unknown, App>, attributes: Attributes = {}): Promise<A> {
    const parent = Tracer.externalSpan(this.parent);

    const callback = (ctx: WorkflowStepContext) =>
      runApp(this.env, body.pipe(
        span(name, "function", { "workflow.step.name": name, "cloudflare.workflow.attempt": ctx.attempt, ...attributes }),
        Effect.withParentSpan(parent),
      ));

    return this.step.do(name, config, callback);
  }

  /** Steps under one span. `phase:` steps keep its id and start for a restart, and write it once at the end. */
  async phase<A>(name: string, fn: (steps: Steps) => Promise<A>, attributes: Attributes = {}, op = "workflow.phase"): Promise<A> {
    const key = `phase:${[name, ...Object.values(attributes)].join(":")}`;
    const { spanId, startMs } = await this.step.do(key, {}, async () => ({ spanId: randomSpanId(), startMs: Date.now() }));

    const end = (failed: boolean) =>
      this.step.do(`${key}:end`, {}, () =>
        runApp(this.env, Effect.flatMap(Telemetry, (telemetry) =>
          telemetry.recordSpan({ ...this.parent, parentSpanId: this.parent.spanId, spanId, name, op, startMs, endMs: Date.now(), failed, attributes }),
        )));

    try {
      const result = await fn(this.under({ traceId: this.parent.traceId, spanId }));
      await end(false);

      return result;
    } catch (err) {
      await end(true);
      throw err;
    }
  }

  /** `waitForEvent` makes no span, so the wait is a phase of its own. A timeout ends that span as an error. */
  waitForEvent<T extends Rpc.Serializable<T>>(name: string, options: { type: string; timeout?: WorkflowTimeoutDuration }) {
    return this.phase(name, () => this.step.waitForEvent<T>(name, options), {}, "workflow.wait");
  }

  /** Writes the span of the whole run. `startMs` comes from the run's first step. */
  recordRun(name: string, startMs: number, failed: boolean, attributes: Attributes) {
    return Effect.flatMap(Telemetry, (telemetry) =>
      telemetry.recordSpan({ traceId: this.parent.traceId, spanId: this.parent.spanId, name, op: "workflow.run", startMs, endMs: Date.now(), failed, attributes }));
  }
}

export type StepConfig = WorkflowStepConfig;
