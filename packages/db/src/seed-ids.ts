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
  // Sprint 11 — Caribbean buyers used by the fuel deal seed.
  massy: make("CRP", 6), // Massy United Industries (Jamaica) — ULSD buyer
  punta: make("CRP", 7), // Punta Caucedo Energy (DR) — ULSD buyer
  caribAir: make("CRP", 8), // Caribbean Airlines (Trinidad) — Jet A1 buyer
  // Sprint V — food line of business demo buyers.
  alimport: make("CRP", 9), // Alimport S.A. (Cuba) — state food importer
  cibao: make("CRP", 10), // Cibao Foods (DR) — distributor, reefers
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

// ---------------------------------------------------------------------------
// Sprint 11 — fuel deal seed IDs
// ---------------------------------------------------------------------------

export const SEED_FUEL_DEAL_IDS = {
  deal1: make("DEA", 1), // VTC-2026-001 — ULSD → Jamaica, low vessel utilization
  deal2: make("DEA", 2), // VTC-2026-002 — ULSD → Dominican Republic, healthy
  deal3: make("DEA", 3), // VTC-2026-003 — Jet A1 → Trinidad, BIS missing
  // Sprint V — food line of business demo rows. Use the same table
  // + id-prefix convention so reset/cleanup logic covers them, but
  // namespace the deal_ref as VTC-F-YYYY-NNN to signal food.
  food1: make("DEA", 101), // VTC-F-2026-001 — Rice → Cuba, BIS pending
  food2: make("DEA", 102), // VTC-F-2026-002 — Pork → Dominican, cold chain
} as const;

export const SEED_FUEL_DEAL_REFS = {
  deal1: "VTC-2026-001",
  deal2: "VTC-2026-002",
  deal3: "VTC-2026-003",
  food1: "VTC-F-2026-001",
  food2: "VTC-F-2026-002",
} as const;

export const SEED_FUEL_DEAL_COST_STACK_IDS = {
  deal1: make("FCS", 1),
  deal2: make("FCS", 2),
  deal3: make("FCS", 3),
} as const;

export const SEED_FUEL_DEAL_SCENARIO_IDS = {
  deal1Base: make("FSC", 1),
  deal2Base: make("FSC", 2),
  deal3Base: make("FSC", 3),
} as const;

/**
 * Flat aliases for the Sprint 11 fuel-deal seed IDs. Eval fixtures and
 * unit tests can reference these short names without drilling into the
 * grouped const objects above. Source of truth remains the grouped
 * objects — these are just re-exports.
 */
export const DEAL_1_ID = SEED_FUEL_DEAL_IDS.deal1;
export const DEAL_2_ID = SEED_FUEL_DEAL_IDS.deal2;
export const DEAL_3_ID = SEED_FUEL_DEAL_IDS.deal3;

export const SCENARIO_1_ID = SEED_FUEL_DEAL_SCENARIO_IDS.deal1Base;
export const SCENARIO_2_ID = SEED_FUEL_DEAL_SCENARIO_IDS.deal2Base;
export const SCENARIO_3_ID = SEED_FUEL_DEAL_SCENARIO_IDS.deal3Base;

/** 15 IDs = 5 cashflow events per deal × 3 deals. */
export const SEED_FUEL_DEAL_CASHFLOW_IDS = Array.from(
  { length: 15 },
  (_, i) => make("FCF", i + 1),
);

export const SEED_COUNTERPARTY_SCORE_IDS = {
  massy: make("CRS", 1),
  punta: make("CRS", 2),
  caribAir: make("CRS", 3),
} as const;

export const SEED_FUEL_MARKET_RATE_IDS = Array.from({ length: 5 }, (_, i) =>
  make("FMR", i + 1),
);

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
  // Sprint 11
  ...Object.values(SEED_FUEL_DEAL_IDS),
  ...Object.values(SEED_FUEL_DEAL_COST_STACK_IDS),
  ...Object.values(SEED_FUEL_DEAL_SCENARIO_IDS),
  ...SEED_FUEL_DEAL_CASHFLOW_IDS,
  ...Object.values(SEED_COUNTERPARTY_SCORE_IDS),
  ...SEED_FUEL_MARKET_RATE_IDS,
];
