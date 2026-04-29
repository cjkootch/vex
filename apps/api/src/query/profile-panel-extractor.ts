import type { ProposedAction } from "@vex/integrations";
import type { ManifestPanel } from "@vex/ui";

/**
 * Path B — server-side panel-to-action extractor.
 *
 * The chat model is reliable at producing a `profile` panel with the
 * right structured facts about an organization, but unreliable at
 * also emitting the parallel `proposed_actions` JSON to persist
 * those facts. v7.22 of the system prompt made the rule mandatory
 * with explicit examples; the model still skips it ~half the time
 * and lies about completion ("has been updated… captured in the
 * system") with an empty actions array.
 *
 * This extractor closes that gap deterministically: scan each
 * profile panel about an existing organization, map known field
 * names to their corresponding T1 action, append to the model's
 * proposed_actions. The model produces the panel; the server
 * produces the actions. No more hallucinated completions.
 *
 * Out of scope:
 *   - T2 actions (crm.create_contact). Operators should review
 *     contact creation; we keep that on the model's plate.
 *   - Non-organization panels. Contact / deal panel field-update
 *     paths can be added later when the actions exist.
 *   - Free-form claims in prose. We only extract from STRUCTURED
 *     panel fields where the value's intent is unambiguous.
 */

export interface ExtractActionsInput {
  panels: ManifestPanel[];
  existingActions: ProposedAction[];
  /** ULID format gate. Panel objectId must match before we emit actions. */
  isValidUlid: (s: string) => boolean;
}

export function extractOrgActionsFromPanels(
  input: ExtractActionsInput,
): ProposedAction[] {
  const out: ProposedAction[] = [];
  for (const panel of input.panels) {
    if (panel.type !== "profile") continue;
    if (panel.objectType !== "organization") continue;
    if (!input.isValidUlid(panel.objectId)) continue;

    const orgId = panel.objectId;
    const fields = panel.fields;

    // org.update_fields — domain / industry / country
    const patch: Record<string, string | null> = {};
    const industry = pickField(fields, ["Industry"]);
    if (industry) patch["industry"] = industry;
    const domain = pickField(fields, ["Domain", "Website"]);
    if (domain) patch["domain"] = normalizeDomain(domain);
    const country = pickField(fields, ["Country", "Headquartered", "HQ"]);
    if (country) {
      const iso = countryToIso2(country);
      if (iso) patch["country"] = iso;
    }
    if (Object.keys(patch).length > 0) {
      out.push({
        kind: "org.update_fields",
        tier: "T1",
        payload: { orgId, patch },
        rationale: "auto-extracted from chat profile panel",
      });
    }

    // org.set_kind — Role / Kind
    const role = pickField(fields, ["Role", "Kind", "Counterparty Role"]);
    const orgKind = role ? roleToKind(role) : null;
    if (orgKind) {
      out.push({
        kind: "org.set_kind",
        tier: "T1",
        payload: { orgId, orgKind },
        rationale: "auto-extracted from chat profile panel",
      });
    }

    // org.tag — Facility Type + Type with refinery/etc cues
    const facility = pickField(fields, ["Facility Type", "Type"]);
    if (facility) {
      for (const tag of facilityToTags(facility)) {
        out.push({
          kind: "org.tag",
          tier: "T1",
          payload: { orgId, tag },
          rationale: "auto-extracted from chat profile panel",
        });
      }
    }

    // org.tag — Ownership signals (state-owned / joint-venture / etc.)
    // "Structure" alone is what the model emits when it's referring
    // to ownership structure — caught in production logs (the panel
    // had Industry/Type/Country/Structure/Capacity/Products/Contact).
    const ownership = pickField(fields, [
      "Ownership",
      "Ownership Structure",
      "Structure",
    ]);
    if (ownership) {
      for (const tag of ownershipToTags(ownership)) {
        out.push({
          kind: "org.tag",
          tier: "T1",
          payload: { orgId, tag },
          rationale: "auto-extracted from chat profile panel",
        });
      }
    }

    // org.add_product — comma-separated list, mapped to enum
    const products = pickField(fields, ["Products", "Product"]);
    if (products) {
      for (const product of productsToEnums(products)) {
        out.push({
          kind: "org.add_product",
          tier: "T1",
          payload: { orgId, product },
          rationale: "auto-extracted from chat profile panel",
        });
      }
    }
  }

  return dedupeAgainstExisting(out, input.existingActions);
}

// ---------------------------------------------------------------------------
// Field pickers — chat panels use varied capitalisations / phrasings; we
// look up against a list and trim. Returns the first non-empty match.
// ---------------------------------------------------------------------------

function pickField(
  fields: Record<string, string>,
  candidates: readonly string[],
): string | null {
  for (const key of candidates) {
    const v = fields[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

// ---------------------------------------------------------------------------
// Country name → ISO 3166-1 alpha-2. Small table of countries operators
// actually deal with. Unmapped countries skip rather than guess — better
// to leave the field blank than stamp an incorrect code.
// ---------------------------------------------------------------------------

const COUNTRY_TO_ISO2: Record<string, string> = {
  algeria: "DZ",
  argentina: "AR",
  bahamas: "BS",
  barbados: "BB",
  belgium: "BE",
  belize: "BZ",
  bolivia: "BO",
  brazil: "BR",
  canada: "CA",
  chile: "CL",
  china: "CN",
  colombia: "CO",
  "costa rica": "CR",
  cuba: "CU",
  curacao: "CW",
  "dominican republic": "DO",
  ecuador: "EC",
  egypt: "EG",
  france: "FR",
  germany: "DE",
  ghana: "GH",
  guatemala: "GT",
  guyana: "GY",
  haiti: "HT",
  honduras: "HN",
  india: "IN",
  indonesia: "ID",
  iraq: "IQ",
  italy: "IT",
  jamaica: "JM",
  japan: "JP",
  kenya: "KE",
  kuwait: "KW",
  libya: "LY",
  mexico: "MX",
  morocco: "MA",
  netherlands: "NL",
  nicaragua: "NI",
  nigeria: "NG",
  norway: "NO",
  panama: "PA",
  paraguay: "PY",
  peru: "PE",
  philippines: "PH",
  qatar: "QA",
  "saudi arabia": "SA",
  senegal: "SN",
  singapore: "SG",
  "south africa": "ZA",
  spain: "ES",
  suriname: "SR",
  switzerland: "CH",
  "trinidad and tobago": "TT",
  tunisia: "TN",
  turkey: "TR",
  uae: "AE",
  "united arab emirates": "AE",
  uk: "GB",
  "united kingdom": "GB",
  uruguay: "UY",
  usa: "US",
  "united states": "US",
  "united states of america": "US",
  venezuela: "VE",
};

export function countryToIso2(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  const key = trimmed.toLowerCase();
  return COUNTRY_TO_ISO2[key] ?? null;
}

// ---------------------------------------------------------------------------
// Role text → org.kind enum. Matches against substrings so mixed forms like
// "Supplier (refinery)" still resolve to "supplier".
// ---------------------------------------------------------------------------

const ORG_KIND_VALUES = [
  "buyer",
  "supplier",
  "broker",
  "buyer_broker",
  "internal",
  "competitor",
] as const;

function roleToKind(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (lower.includes("buyer") && lower.includes("broker")) return "buyer_broker";
  for (const k of ORG_KIND_VALUES) {
    if (lower.includes(k.replace("_", " ")) || lower.includes(k)) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Facility-type extraction — order matters; longer / more specific matches
// win. Returns kebab-case tags.
// ---------------------------------------------------------------------------

const FACILITY_TAGS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\brefinery\b/i, tag: "refinery" },
  { pattern: /\bterminal\b/i, tag: "terminal" },
  { pattern: /\btrading[- ]house\b/i, tag: "trading-house" },
  { pattern: /\bproducer\b/i, tag: "producer" },
  { pattern: /\bdistributor\b/i, tag: "distributor" },
  { pattern: /\bblender\b/i, tag: "blender" },
  { pattern: /\blpg[- ]importer\b/i, tag: "lpg-importer" },
  { pattern: /\bmarine[- ]bunker(ing)?\b/i, tag: "marine-bunker" },
  { pattern: /\bwholesaler\b/i, tag: "wholesaler" },
];

function facilityToTags(raw: string): string[] {
  const out: string[] = [];
  for (const { pattern, tag } of FACILITY_TAGS) {
    if (pattern.test(raw)) out.push(tag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ownership-text extraction — common descriptors that come up in research
// briefs. Skip plain text like "private" since that's too generic to tag.
// ---------------------------------------------------------------------------

const OWNERSHIP_TAGS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bjoint[- ]venture\b/i, tag: "joint-venture" },
  { pattern: /\bstate[- ]owned\b/i, tag: "state-owned" },
  { pattern: /\bgovernment[- ]owned\b/i, tag: "state-owned" },
  { pattern: /\bnationalised?\b/i, tag: "state-owned" },
  { pattern: /\bpublicly[- ]listed\b/i, tag: "publicly-listed" },
  { pattern: /\bpublic(ly)? traded\b/i, tag: "publicly-listed" },
  {
    pattern: /\bprivate equity\b/i,
    tag: "private-equity-backed",
  },
  { pattern: /\bfamily[- ]owned\b/i, tag: "family-business" },
  { pattern: /\bfamily business\b/i, tag: "family-business" },
];

function ownershipToTags(raw: string): string[] {
  const out: string[] = [];
  for (const { pattern, tag } of OWNERSHIP_TAGS) {
    if (pattern.test(raw)) out.push(tag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Product list parser → enum values from action.ts. Splits on commas /
// slashes, trims, normalises common variants. Skips unknown products
// rather than guessing.
// ---------------------------------------------------------------------------

const PRODUCT_ALIASES: Record<string, string> = {
  // fuels
  gasoline: "gasoline_87",
  "gasoline 87": "gasoline_87",
  "gasoline 91": "gasoline_91",
  "gasoline 87/93": "gasoline_87",
  petrol: "gasoline_87",
  diesel: "ulsd",
  "diesel oil": "ulsd",
  ulsd: "ulsd",
  "jet fuel": "jet_a1",
  "jet a": "jet_a",
  "jet a-1": "jet_a1",
  "jet a1": "jet_a1",
  jet: "jet_a1",
  "kerosene jet a-1": "jet_a1",
  avgas: "avgas",
  lfo: "lfo",
  hfo: "hfo",
  "fuel oil": "hfo",
  "heavy fuel oil": "hfo",
  lng: "lng",
  lpg: "lpg",
  "liquefied petroleum gas": "lpg",
  biodiesel: "biodiesel_b20",
  "biodiesel b20": "biodiesel_b20",
  // food
  rice: "rice",
  beans: "beans",
  pork: "pork",
  chicken: "chicken",
  "cooking oil": "cooking_oil",
  "powdered milk": "powdered_milk",
};

function productsToEnums(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Split on commas, slashes, semicolons, " and ".
  const parts = raw
    .split(/,|\/|;|\band\b/i)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const part of parts) {
    const cleaned = part.replace(/\s+/g, " ").replace(/[^a-z0-9 -]/g, "");
    const enumValue = PRODUCT_ALIASES[cleaned];
    if (!enumValue) continue;
    if (seen.has(enumValue)) continue;
    seen.add(enumValue);
    out.push(enumValue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedupe — skip extracted actions that already exist in the model's
// proposed_actions (rare, but happens when the model DOES emit them).
// Keys on (kind, orgId, secondary identifier) so we don't double-tag /
// double-product.
// ---------------------------------------------------------------------------

function dedupeAgainstExisting(
  extracted: ProposedAction[],
  existing: ProposedAction[],
): ProposedAction[] {
  const existingKeys = new Set(existing.map(actionKey));
  return extracted.filter((a) => !existingKeys.has(actionKey(a)));
}

function actionKey(a: ProposedAction): string {
  const p = a.payload as Record<string, unknown>;
  const orgId = String(p["orgId"] ?? "");
  if (a.kind === "org.tag") return `org.tag:${orgId}:${String(p["tag"] ?? "")}`;
  if (a.kind === "org.add_product")
    return `org.add_product:${orgId}:${String(p["product"] ?? "")}`;
  if (a.kind === "org.set_kind")
    return `org.set_kind:${orgId}:${String(p["orgKind"] ?? "")}`;
  if (a.kind === "org.update_fields") return `org.update_fields:${orgId}`;
  return `${a.kind}:${orgId}`;
}
