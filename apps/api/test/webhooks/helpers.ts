import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { Queue } from "bullmq";
import { vi } from "vitest";
import type { NormalizationJobData } from "@vex/agents";
import type { Db, RawEventRepository, Tx } from "@vex/db";
import { AppModule } from "../../src/app.module.js";
import { WebhooksModule } from "../../src/webhooks/webhooks.module.js";

export interface FakeQueueRecord {
  jobName: string;
  data: NormalizationJobData;
  jobId?: string;
}

export interface FakeQueue extends Pick<Queue<NormalizationJobData>, "add"> {
  calls: FakeQueueRecord[];
}

export function makeFakeQueue(): FakeQueue {
  const calls: FakeQueueRecord[] = [];
  return {
    calls,
    async add(jobName: string, data: NormalizationJobData, opts?: { jobId?: string }) {
      calls.push({ jobName, data, ...(opts?.jobId ? { jobId: opts.jobId } : {}) });
      return { id: opts?.jobId ?? `job-${calls.length}` } as never;
    },
  };
}

export type InsertCall = Parameters<RawEventRepository["insertIfNotExists"]>;

export interface FakeRawEventRepo extends Pick<RawEventRepository, "insertIfNotExists"> {
  calls: InsertCall[];
  /** Override the next return value (defaults to a fresh row each call). */
  nextResult?: { id: string; isNew: boolean };
}

export function makeFakeRawEventRepo(): FakeRawEventRepo {
  const calls: InsertCall[] = [];
  const repo: FakeRawEventRepo = {
    calls,
    async insertIfNotExists(...args: InsertCall) {
      calls.push(args);
      const result = repo.nextResult ?? {
        id: `01HSEEDRAW000000000000000${String(calls.length).padStart(2, "0")}`,
        isNew: true,
      };
      repo.nextResult = undefined as never;
      return result;
    },
  };
  return repo;
}

/**
 * Fake `Db` whose `transaction` runs the callback with a stub `Tx`. The
 * stub is enough to satisfy `withTenant` — it just needs to expose
 * `execute()` for the SET LOCAL call. The real query work happens through
 * the injected fake repository which receives `tx` but ignores it.
 */
export function makeFakeDb(): Db {
  const tx = {
    execute: vi.fn(async () => undefined),
  } as unknown as Tx;
  return {
    transaction: async <T>(cb: (t: Tx) => Promise<T>) => cb(tx),
  } as unknown as Db;
}

export interface BuildTestAppOptions {
  resendSecret: string;
  twilioAuthToken: string;
  websiteChatSecret?: string;
  rawEventRepo?: FakeRawEventRepo;
  queue?: FakeQueue;
  db?: Db;
  resolveTenant?: () => string;
}

export interface TestAppHandles {
  app: NestFastifyApplication;
  rawEventRepo: FakeRawEventRepo;
  queue: FakeQueue;
  close: () => Promise<void>;
}

/**
 * Boot a Nest+Fastify test app with the WebhooksModule wired to fakes. Use
 * `app.inject(...)` from Fastify to drive HTTP requests in-memory.
 */
export async function buildTestApp(
  options: BuildTestAppOptions,
): Promise<TestAppHandles> {
  const rawEventRepo = options.rawEventRepo ?? makeFakeRawEventRepo();
  const queue = options.queue ?? makeFakeQueue();
  const db = options.db ?? makeFakeDb();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      nextAuthSecret: TEST_NEXTAUTH_SECRET,
      webhooks: WebhooksModule.register({
        db,
        rawEventRepository: rawEventRepo as unknown as RawEventRepository,
        normalizationQueue: queue as unknown as Queue<NormalizationJobData>,
        resendSecret: options.resendSecret,
        twilioAuthToken: options.twilioAuthToken,
        websiteChatSecret:
          options.websiteChatSecret ?? TEST_WEBSITE_CHAT_SECRET,
        resolveTenant: options.resolveTenant ?? (() => "01HSEEDWRK0000000000000001"),
      }),
    }),
    new FastifyAdapter(),
    { rawBody: true, logger: ["error"], abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    rawEventRepo,
    queue,
    async close() {
      await app.close();
    },
  };
}

export const TEST_RESEND_SECRET =
  "whsec_" + Buffer.from("test-secret-bytes-1234567890abcdef").toString("base64");

export const TEST_TWILIO_AUTH_TOKEN = "twilio-test-auth-token-do-not-use";

export const TEST_WEBSITE_CHAT_SECRET = "website-chat-test-secret-do-not-use";

export const TEST_NEXTAUTH_SECRET =
  "test-nextauth-secret-must-be-at-least-32-chars-long";

/** Stop ESLint complaining when vi is imported only for type side-effects. */
export const _vi = vi;
