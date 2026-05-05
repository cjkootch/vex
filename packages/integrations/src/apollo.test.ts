import { describe, expect, it, vi } from "vitest";
import { createApolloClient } from "./apollo.js";

const SAMPLE_RESPONSE = {
  total_entries: 2,
  people: [
    {
      id: "abc123",
      first_name: "John",
      last_name_obfuscated: "Sm***h",
      title: "Fuel Procurement Manager",
      last_refreshed_at: "2025-11-04T12:00:00Z",
      has_email: true,
      has_city: true,
      has_state: true,
      has_country: true,
      has_direct_phone: "Yes",
      organization: {
        name: "Vitol",
        has_industry: true,
        has_phone: true,
        has_city: true,
        has_state: true,
        has_country: true,
        has_zip_code: true,
        has_revenue: true,
        has_employee_count: true,
      },
    },
  ],
};

function makeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("createApolloClient", () => {
  it("isEnabled returns false when no api key", () => {
    const c = createApolloClient({ apiKey: null });
    expect(c.isEnabled()).toBe(false);
  });

  it("peopleSearch returns disabled when no api key", async () => {
    const c = createApolloClient({ apiKey: null });
    const r = await c.peopleSearch({ person_titles: ["x"] });
    expect(r).toEqual({ ok: false, reason: "disabled" });
  });

  it("peopleSearch posts to the search path with x-api-key header", async () => {
    const fetchImpl = makeFetch(200, SAMPLE_RESPONSE);
    const c = createApolloClient({ apiKey: "MASTER", fetchImpl });
    const r = await c.peopleSearch({
      person_titles: ["Fuel Procurement Manager"],
      person_seniorities: ["director", "manager"],
      q_organization_domains_list: ["vitol.com"],
      per_page: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.people).toHaveLength(1);

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toContain("/mixed_people/api_search");
    expect(url).toContain("person_titles%5B%5D=Fuel+Procurement+Manager");
    expect(url).toContain("person_seniorities%5B%5D=director");
    expect(url).toContain("person_seniorities%5B%5D=manager");
    expect(url).toContain("q_organization_domains_list%5B%5D=vitol.com");
    expect(url).toContain("per_page=5");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("MASTER");
    expect(init.method).toBe("POST");
  });

  it("peopleSearch caps per_page at 100", async () => {
    const fetchImpl = makeFetch(200, SAMPLE_RESPONSE);
    const c = createApolloClient({ apiKey: "MASTER", fetchImpl });
    await c.peopleSearch({ per_page: 999 });
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toContain("per_page=100");
  });

  it("peopleSearch surfaces http_error on 4xx/5xx", async () => {
    const fetchImpl = makeFetch(429, { message: "rate limited" });
    const c = createApolloClient({ apiKey: "MASTER", fetchImpl });
    const r = await c.peopleSearch({ person_titles: ["x"] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("http_error");
    expect(r.status).toBe(429);
  });

  it("peopleSearch surfaces exception on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const c = createApolloClient({ apiKey: "MASTER", fetchImpl });
    const r = await c.peopleSearch({ person_titles: ["x"] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("exception");
  });
});
