/**
 * Thin Tavily Search API wrapper. Tavily returns an LLM-ready
 * digest of the top web results for a query — perfect for the chat
 * agent's `research_contact` tool. Returns null when the API key
 * isn't configured; callers surface a clean "research unavailable"
 * message to the user in that case.
 *
 * API reference: https://docs.tavily.com/docs/rest-api/api-reference
 */

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface TavilySearchResponse {
  query: string;
  answer: string | null;
  results: TavilySearchResult[];
}

export interface TavilyClient {
  search(
    query: string,
    opts?: {
      /** "basic" (1 credit, faster) or "advanced" (2 credits, deeper extraction). */
      depth?: "basic" | "advanced";
      maxResults?: number;
      /** Ask Tavily to include an LLM-generated digest alongside the raw results. */
      includeAnswer?: boolean;
      /** Optional list of domain prefixes to restrict to (e.g. ["linkedin.com"]). */
      includeDomains?: string[];
    },
  ): Promise<TavilySearchResponse>;
}

export interface TavilyDeps {
  apiKey: string;
}

export function createTavilyClient(deps: TavilyDeps): TavilyClient {
  return {
    async search(query, opts) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: deps.apiKey,
          query,
          search_depth: opts?.depth ?? "basic",
          max_results: opts?.maxResults ?? 5,
          include_answer: opts?.includeAnswer ?? true,
          include_raw_content: false,
          ...(opts?.includeDomains ? { include_domains: opts.includeDomains } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `tavily search failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        );
      }
      const data = (await res.json()) as {
        answer?: string | null;
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          score?: number;
        }>;
      };
      return {
        query,
        answer: typeof data.answer === "string" ? data.answer : null,
        results: (data.results ?? []).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          content: r.content ?? "",
          ...(typeof r.score === "number" ? { score: r.score } : {}),
        })),
      };
    },
  };
}
