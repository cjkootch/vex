import { promises as dns } from "node:dns";

/**
 * Two-tier email verification used at the email.send executor
 * pre-flight (worker) and at chat-time chip creation (api).
 *
 * - Tier 1 — SYNTAX: cheap regex against an RFC-5321-ish shape.
 *   Catches typos and missing TLDs in O(1).
 * - Tier 2 — MX RECORDS: DNS lookup against the address's domain.
 *   Catches dead domains and recipients on hosts that don't accept
 *   email at all (a not-uncommon failure mode for small B2B sites
 *   where the marketing site domain has never been MX-configured).
 *
 * What this DOES NOT do (deliberate):
 *   - Catch-all detection (would need an SMTP probe; flaky + risky)
 *   - Mailbox existence (same — SMTP RCPT TO probe; rate-limited
 *     by every major provider, and accuracy is poor)
 *   - DMARC / SPF / DKIM verification (sender-side concerns; we're
 *     verifying the recipient address)
 *
 * The result `EmailVerification` reports the strongest failure
 * found. Callers branch on `verdict`:
 *   - `valid`            → safe to send
 *   - `syntax_invalid`   → operator typo or junk; refuse send
 *   - `domain_unreachable` → dead domain or no MX; refuse send,
 *                            ask operator to verify the address
 *   - `dns_error`        → infrastructure problem on our side;
 *                          we DON'T refuse the send (would create
 *                          a self-DOS where a flaky DNS resolver
 *                          blocks legitimate outbound). Caller
 *                          logs and proceeds.
 */

export interface EmailVerification {
  email: string;
  verdict:
    | "valid"
    | "syntax_invalid"
    | "domain_unreachable"
    | "dns_error";
  /** Domain part of the email; null when syntax is invalid. */
  domain: string | null;
  /** Human-readable reason. Surfaced on rejected-proposal chips + executor failure events. */
  reason: string;
}

const SYNTAX_REGEX =
  /^[a-zA-Z0-9._%+\-!#$&'*/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Pure syntax check — no DNS, no I/O. Cheap enough to call
 * from any code path. Returns `true` iff the address looks like
 * a deliverable RFC-5321 address shape.
 *
 * Conservative on the local-part: allows the standard punctuation
 * set most B2B addresses use. Doesn't permit quoted local-parts
 * (`"first.last"@example.com`) — extremely rare in B2B and prone
 * to being a parser-confused junk address.
 */
export function emailSyntaxValid(email: string): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  return SYNTAX_REGEX.test(trimmed);
}

export function extractDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Full verification — syntax + MX. Async because of DNS. Caller
 * decides what to do per verdict (see EmailVerification doc).
 *
 * `resolveMx` is injectable for tests; defaults to Node's built-in
 * dns.promises.resolveMx. Real DNS resolution typically completes
 * in 5-50ms; we cap at 2s to avoid blocking a Resend send on a
 * slow resolver.
 */
export async function verifyEmail(
  email: string,
  options: {
    resolveMx?: (
      domain: string,
    ) => Promise<Array<{ exchange: string; priority: number }>>;
    timeoutMs?: number;
  } = {},
): Promise<EmailVerification> {
  const trimmed = email.trim();
  if (!emailSyntaxValid(trimmed)) {
    return {
      email: trimmed,
      verdict: "syntax_invalid",
      domain: null,
      reason: "address doesn't look like a deliverable email (syntax check failed)",
    };
  }

  const domain = extractDomain(trimmed);
  if (!domain) {
    return {
      email: trimmed,
      verdict: "syntax_invalid",
      domain: null,
      reason: "couldn't extract a domain from the address",
    };
  }

  const resolveMx = options.resolveMx ?? dns.resolveMx.bind(dns);
  const timeoutMs = options.timeoutMs ?? 2_000;

  let records: Array<{ exchange: string; priority: number }>;
  try {
    records = await withTimeout(resolveMx(domain), timeoutMs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    // ENOTFOUND / ENODATA are definitive — domain has no MX records.
    // Anything else is a DNS infrastructure issue we don't want to
    // weaponise into a self-DOS.
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return {
        email: trimmed,
        verdict: "domain_unreachable",
        domain,
        reason: `domain ${domain} has no MX records (${code})`,
      };
    }
    return {
      email: trimmed,
      verdict: "dns_error",
      domain,
      reason: `DNS lookup failed for ${domain}: ${(err as Error).message}`,
    };
  }

  if (records.length === 0) {
    return {
      email: trimmed,
      verdict: "domain_unreachable",
      domain,
      reason: `domain ${domain} resolved with zero MX records`,
    };
  }

  return {
    email: trimmed,
    verdict: "valid",
    domain,
    reason: `domain ${domain} has ${records.length} MX record(s); deliverable`,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error("dns_timeout"), { code: "ETIMEDOUT" })),
        ms,
      ),
    ),
  ]);
}
