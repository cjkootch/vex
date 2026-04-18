import { Module, type DynamicModule } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Db } from "@vex/db";
import type { OpenAIAdapter } from "@vex/integrations";
import type { VoiceContextBuilder, TranscriptJobData } from "@vex/agents";
import { VoiceController } from "./voice.controller.js";
import { VoiceService } from "./voice.service.js";
import {
  VOICE_CONTEXT_BUILDER,
  VOICE_DB_CLIENT,
  VOICE_OPENAI_ADAPTER,
  VOICE_SESSION_STORE,
  VOICE_TRANSCRIPT_QUEUE,
} from "./tokens.js";
import type { VoiceSessionStore } from "./voice-session-store.js";

export interface VoiceModuleConfig {
  db: Db;
  openai: OpenAIAdapter;
  sessionStore: VoiceSessionStore;
  contextBuilder: VoiceContextBuilder;
  transcriptQueue: Queue<TranscriptJobData>;
}

@Module({})
export class VoiceModule {
  static register(config: VoiceModuleConfig): DynamicModule {
    return {
      module: VoiceModule,
      controllers: [VoiceController],
      providers: [
        { provide: VOICE_DB_CLIENT, useFactory: () => config.db },
        { provide: VOICE_OPENAI_ADAPTER, useFactory: () => config.openai },
        { provide: VOICE_SESSION_STORE, useFactory: () => config.sessionStore },
        { provide: VOICE_CONTEXT_BUILDER, useFactory: () => config.contextBuilder },
        { provide: VOICE_TRANSCRIPT_QUEUE, useFactory: () => config.transcriptQueue },
        VoiceService,
      ],
    };
  }
}
