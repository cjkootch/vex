import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Db, RawEventRepository } from "@vex/db";
import type { NormalizationJobData } from "@vex/agents";
import { WebhooksController } from "./webhooks.controller.js";
import { ResendVerifier } from "./resend-verifier.js";
import { TwilioVerifier } from "./twilio-verifier.js";
import { WebsiteChatVerifier } from "./website-chat-verifier.js";
import {
  DB_CLIENT,
  NORMALIZATION_QUEUE,
  RAW_EVENT_REPO,
  RESEND_INBOUND_VERIFIER,
  RESEND_VERIFIER,
  TWILIO_VERIFIER,
  WEBHOOK_TENANT_RESOLVER,
  WEBSITE_CHAT_VERIFIER,
  type WebhookTenantResolver,
} from "./tokens.js";

export interface WebhooksModuleConfig {
  db: Db;
  rawEventRepository: RawEventRepository;
  normalizationQueue: Queue<NormalizationJobData>;
  resendSecret: string;
  /**
   * Svix secret for Resend Inbound webhook endpoint (separate from
   * the outbound delivery webhook). Falls back to `resendSecret`
   * when omitted — Resend dashboards let operators reuse one secret
   * across endpoints if they prefer, though a distinct secret per
   * endpoint is best practice.
   */
  resendInboundSecret?: string;
  twilioAuthToken: string;
  websiteChatSecret: string;
  resolveTenant: WebhookTenantResolver;
}

@Module({})
export class WebhooksModule {
  static register(config: WebhooksModuleConfig): DynamicModule {
    return {
      module: WebhooksModule,
      controllers: [WebhooksController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => config.db },
        { provide: RAW_EVENT_REPO, useFactory: () => config.rawEventRepository },
        { provide: NORMALIZATION_QUEUE, useFactory: () => config.normalizationQueue },
        {
          provide: RESEND_VERIFIER,
          useFactory: () => new ResendVerifier({ secret: config.resendSecret }),
        },
        {
          provide: RESEND_INBOUND_VERIFIER,
          useFactory: () =>
            new ResendVerifier({
              secret: config.resendInboundSecret ?? config.resendSecret,
            }),
        },
        {
          provide: TWILIO_VERIFIER,
          useFactory: () => new TwilioVerifier({ authToken: config.twilioAuthToken }),
        },
        {
          provide: WEBSITE_CHAT_VERIFIER,
          useFactory: () =>
            new WebsiteChatVerifier({ secret: config.websiteChatSecret }),
        },
        { provide: WEBHOOK_TENANT_RESOLVER, useFactory: () => config.resolveTenant },
      ],
    };
  }
}
