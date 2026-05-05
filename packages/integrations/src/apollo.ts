/**
 * Apollo.io People API Search client.
 *
 * Apollo's people search returns net-new candidates filtered by
 * company domain, role, seniority, location, etc. The search endpoint
 * is FREE (doesn't consume credits) but only returns identity +
 * has_email/has_phone booleans — actual emails and phones come from
 * the People Enrichment endpoint, which is paid (separate PR).
 *
 * Master API key required. Endpoint cap: 50,000 records per query
 * (100/page × 500 pages); rate-limited at 600 requests/hour.
 *
 * Operator flow:
 *   1. Chat: "find me a fuel procurement manager at Vitol"
 *   2. Agent calls peopleSearch({
 *        q_organization_domains_list: ["vitol.com"],
 *        person_titles: ["Fuel Procurement Manager", ...registry],
 *        person_seniorities: ["director", "manager", "vp"]
 *      })
 *   3. Returns up to 10 candidates with name + title + has_email
 *   4. Operator picks one (next PR will add enrichment)
 */

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export interface ApolloClientConfig {
  apiKey: string | null;
  fetchImpl?: typeof fetch;
}

export interface ApolloPeopleSearchArgs {
  /** Job title strings — Apollo matches loosely (e.g. "marketing manager" → "content marketing manager"). */
  person_titles?: string[];
  /** Set false to require strict-match titles. Default true (broader). */
  include_similar_titles?: boolean;
  /** Free-text keyword filter. */
  q_keywords?: string;
  /** Where the person LIVES (cities / US states / countries). */
  person_locations?: string[];
  /** Seniority enum: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern. */
  person_seniorities?: string[];
  /** Headquarters location of person's current employer. */
  organization_locations?: string[];
  /** Company domains the person works at. NO `www.`, no `@`. Up to 1000. */
  q_organization_domains_list?: string[];
  /** Apollo-internal organization IDs. */
  organization_ids?: string[];
  /** Employee-count ranges: "1,10", "250,500", "10000,20000". */
  organization_num_employees_ranges?: string[];
  page?: number;
  per_page?: number;
}

export interface ApolloPersonResult {
  id: string;
  first_name: string;
  /** Apollo obfuscates the last name in search results — full name comes from enrichment. */
  last_name_obfuscated: string;
  title: string | null;
  last_refreshed_at: string;
  has_email: boolean;
  has_city: boolean;
  has_state: boolean;
  has_country: boolean;
  /** "Yes" | "Maybe: please request direct dial via people/bulk_match". */
  has_direct_phone: string;
  organization: {
    name: string;
    has_industry: boolean;
    has_phone: boolean;
    has_city: boolean;
    has_state: boolean;
    has_country: boolean;
    has_zip_code: boolean;
    has_revenue: boolean;
    has_employee_count: boolean;
  };
}

export interface ApolloPeopleSearchResult {
  total_entries: number;
  people: ApolloPersonResult[];
}

export type ApolloResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "disabled" | "http_error" | "exception"; status?: number; message?: string };

export interface ApolloClient {
  isEnabled(): boolean;
  peopleSearch(args: ApolloPeopleSearchArgs): Promise<ApolloResult<ApolloPeopleSearchResult>>;
}

export function createApolloClient(config: ApolloClientConfig): ApolloClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const enabled = !!config.apiKey;

  return {
    isEnabled() {
      return enabled;
    },

    async peopleSearch(args) {
      if (!enabled || !config.apiKey) {
        return { ok: false, reason: "disabled" };
      }
      const params = new URLSearchParams();
      const append = (key: string, value: string): void => params.append(key, value);
      const appendList = (key: string, values: string[] | undefined): void => {
        if (!values) return;
        for (const v of values) append(`${key}[]`, v);
      };

      appendList("person_titles", args.person_titles);
      if (args.include_similar_titles !== undefined) {
        append("include_similar_titles", String(args.include_similar_titles));
      }
      if (args.q_keywords) append("q_keywords", args.q_keywords);
      appendList("person_locations", args.person_locations);
      appendList("person_seniorities", args.person_seniorities);
      appendList("organization_locations", args.organization_locations);
      appendList("q_organization_domains_list", args.q_organization_domains_list);
      appendList("organization_ids", args.organization_ids);
      appendList(
        "organization_num_employees_ranges",
        args.organization_num_employees_ranges,
      );
      append("page", String(args.page ?? 1));
      append("per_page", String(Math.min(args.per_page ?? 10, 100)));

      const url = `${APOLLO_BASE}/mixed_people/api_search?${params.toString()}`;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
            "X-Api-Key": config.apiKey,
          },
        });
        if (!res.ok) {
          return {
            ok: false,
            reason: "http_error",
            status: res.status,
            message: await res.text().catch(() => `HTTP ${res.status}`),
          };
        }
        const data = (await res.json()) as ApolloPeopleSearchResult;
        return { ok: true, data };
      } catch (err) {
        return {
          ok: false,
          reason: "exception",
          message: (err as Error).message,
        };
      }
    },
  };
}
