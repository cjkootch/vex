/**
 * Tiny HTTPS client for the Vex API. The token is a NextAuth JWE
 * issued by `scripts/mint-token.ts` so the existing JwtAuthGuard
 * accepts it as-is and TenantContext scopes the request correctly.
 */
export interface VexClientConfig {
  apiUrl: string;
  apiToken: string;
}

export interface VexClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function createVexClient(config: VexClientConfig): VexClient {
  const headers = {
    authorization: `Bearer ${config.apiToken}`,
    "content-type": "application/json",
  };

  const buildUrl = (
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string => {
    const url = new URL(path.replace(/^\//, ""), config.apiUrl.replace(/\/?$/, "/"));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  };

  const handle = async (res: Response): Promise<unknown> => {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `vex api ${res.status}: ${text.slice(0, 500) || res.statusText}`,
      );
    }
    return text ? JSON.parse(text) : null;
  };

  return {
    async get(path, query) {
      const res = await fetch(buildUrl(path, query), { headers, method: "GET" });
      return handle(res) as Promise<never>;
    },
    async post(path, body) {
      const res = await fetch(buildUrl(path), {
        headers,
        method: "POST",
        body: JSON.stringify(body),
      });
      return handle(res) as Promise<never>;
    },
  };
}
