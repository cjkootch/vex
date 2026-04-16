import { afterEach, describe, expect, it } from "vitest";
import { encode } from "@auth/core/jwt";
import {
  TEST_NEXTAUTH_SECRET,
  TEST_RESEND_SECRET,
  TEST_TWILIO_AUTH_TOKEN,
  buildTestApp,
  type TestAppHandles,
} from "../webhooks/helpers.js";
import { NEXTAUTH_SALT } from "../../src/auth/jwt-auth.guard.js";

const TENANT_A = "01HSEEDWRK000000000000000A";
const USER_A = "01HSEEDPRS000000000000000A";

async function vexJwt(claims: Record<string, unknown>): Promise<string> {
  return encode({
    secret: TEST_NEXTAUTH_SECRET,
    salt: NEXTAUTH_SALT,
    token: claims,
    maxAge: 60 * 60,
  });
}

describe("apps/api auth", () => {
  let handles: TestAppHandles | undefined;

  afterEach(async () => {
    if (handles) await handles.close();
    handles = undefined;
  });

  it("returns 401 with no Authorization header", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const response = await handles.app.inject({
      method: "GET",
      url: "/organizations",
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 with a malformed token", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const response = await handles.app.inject({
      method: "GET",
      url: "/organizations",
      headers: { authorization: "Bearer not-a-real-jwe" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 when the token is signed with the wrong secret", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const wrongSecretToken = await encode({
      secret: "a-totally-different-secret-32chars!",
      salt: NEXTAUTH_SALT,
      token: { userId: USER_A, tenantId: TENANT_A, workspaceId: TENANT_A, role: "owner" },
      maxAge: 60,
    });
    const response = await handles.app.inject({
      method: "GET",
      url: "/organizations",
      headers: { authorization: `Bearer ${wrongSecretToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("accepts a valid JWE and exposes tenantId via TenantContext", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const token = await vexJwt({
      userId: USER_A,
      tenantId: TENANT_A,
      workspaceId: TENANT_A,
      role: "owner",
      email: "alice@acme.test",
    });
    const response = await handles.app.inject({
      method: "GET",
      url: "/organizations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, string>;
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.userId).toBe(USER_A);
    expect(body.workspaceId).toBe(TENANT_A);
  });

  it("rejects a token whose role claim is invalid", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    const token = await vexJwt({
      userId: USER_A,
      tenantId: TENANT_A,
      workspaceId: TENANT_A,
      role: "superuser",
    });
    const response = await handles.app.inject({
      method: "GET",
      url: "/organizations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("leaves the webhook routes unauthenticated", async () => {
    handles = await buildTestApp({
      resendSecret: TEST_RESEND_SECRET,
      twilioAuthToken: TEST_TWILIO_AUTH_TOKEN,
    });
    // No Authorization header — webhook should still receive the request,
    // and the verifier rejects the unsigned body with 400 (not 401).
    const response = await handles.app.inject({
      method: "POST",
      url: "/webhooks/resend",
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
  });
});
