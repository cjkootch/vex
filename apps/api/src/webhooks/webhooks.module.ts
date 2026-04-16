import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Db, RawEventRepository } from "@vex/db";
import type { NormalizationJobData } from "@vex/agents";
import { WebhooksController } from "./webhooks.controller.js";
import { ResendVerifier } from "./resend-verifier.js";
import { TwilioVerifier } from "./twilio-verifier.js";
import {
  DB_CLIENT,
  NORMALIZATION_QUEUE,
  RAW_EVENT_REPO,
  RESEND_VERIFIER,
  TWILIO_VERIFIER,
  WEBHOOK_TENANT_RESOLVER,
  type WebhookTenantResolver,
} from "./tokens.js";

export interface WebhooksModuleConfig {
  db: Db;
  rawEventRepository: RawEventRepository;
  normalizationQueue: Queue<NormalizationJobData>;
  resendSecret: string;
  twilioAuthToken: string;
  resolveTenant: WebhookTenantResolver;
}

@Module({})
export class WebhooksModule {
  static register(config: WebhooksModuleConfig): DynamicModule {
    return {
      module: WebhooksModule,
      controllers: [WebhooksController],
      providers: [
        { provide: DB_CLIENT, useValue: config.db },
        { provide: RAW_EVENT_REPO, useValue: config.rawEventRepository },
        { provide: NORMALIZATION_QUEUE, useValue: config.normalizationQueue },
        {
          provide: RESEND_VERIFIER,
          useValue: new ResendVerifier({ secret: config.resendSecret }),
        },
        {
          provide: TWILIO_VERIFIER,
          useValue: new TwilioVerifier({ authToken: config.twilioAuthToken }),
        },
        { provide: WEBHOOK_TENANT_RESOLVER, useValue: config.resolveTenant },
      ],
    };
  }
}
