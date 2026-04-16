/**
 * Stable seed IDs.
 *
 * These are hand-picked ULID-shaped strings (Crockford base32, no I/L/O/U)
 * so the eval fixtures can reference specific records without having to
 * hydrate a registry at test time. Encoding: `01HSEED{KIND}{SEQ}` where
 * `KIND` is a 3-char code and `SEQ` is a 2-digit zero-padded decimal.
 */

const make = (kind: string, seq: number): string => {
  const kindPart = kind.padStart(3, "0");
  const seqPart = String(seq).padStart(16, "0");
  const id = `01HSEED${kindPart}${seqPart}`;
  if (id.length !== 26) {
    throw new Error(`seed id has wrong length: ${id}`);
  }
  return id;
};

export const SEED_WORKSPACE_ID = make("WRK", 1);
export const SEED_ADMIN_USER_ID = make("PRS", 1);

export const SEED_ORG_IDS = {
  acme: make("CRP", 1),
  globex: make("CRP", 2),
  initech: make("CRP", 3),
  umbrella: make("CRP", 4),
  stark: make("CRP", 5),
} as const;

export const SEED_CONTACT_IDS = Array.from({ length: 20 }, (_, i) => make("CNT", i + 1));

export const SEED_CAMPAIGN_IDS = {
  emailNurture: make("CMP", 1),
  paidSearchQ2: make("CMP", 2),
  outboundSdrs: make("CMP", 3),
} as const;

export const SEED_TOUCHPOINT_IDS = Array.from({ length: 15 }, (_, i) => make("TCH", i + 1));

export const SEED_SUMMARY_IDS = {
  acmeOrgSummary: make("SMR", 1),
  globexOrgSummary: make("SMR", 2),
  initechOrgSummary: make("SMR", 3),
  contact1Summary: make("SMR", 4),
  contact2Summary: make("SMR", 5),
} as const;

export const SEED_RAW_EVENT_IDS = Array.from({ length: 3 }, (_, i) => make("RAW", i + 1));
export const SEED_EVENT_IDS = Array.from({ length: 3 }, (_, i) => make("EVT", i + 1));

/**
 * Flat list of every seed ID. Useful for sanity-checking fixtures.
 */
export const ALL_SEED_IDS: readonly string[] = [
  SEED_WORKSPACE_ID,
  SEED_ADMIN_USER_ID,
  ...Object.values(SEED_ORG_IDS),
  ...SEED_CONTACT_IDS,
  ...Object.values(SEED_CAMPAIGN_IDS),
  ...SEED_TOUCHPOINT_IDS,
  ...Object.values(SEED_SUMMARY_IDS),
  ...SEED_RAW_EVENT_IDS,
  ...SEED_EVENT_IDS,
];
