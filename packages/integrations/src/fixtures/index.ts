import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface WebhookFixture {
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadWebhookFixture(name: string): WebhookFixture {
  const path = resolve(HERE, `${name}.json`);
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as WebhookFixture;
  return parsed;
}
