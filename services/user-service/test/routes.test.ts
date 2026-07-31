/**
 * user-service validation boundary tests.
 *
 * AC6/AC12: Valid and invalid payloads; route param identifier validation.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { UserDomain } from "../src/routes/users.js";

function makeDomain(): UserDomain {
  return {
    getProfile: vi.fn(async () => ({ id: "user-1", email: "a@b.com" })),
    updatePreferences: vi.fn(async () => ({ userId: "user-1" })),
  };
}

const VALID_USER_ID = "user-123";

describe("GET /users/:userId/profile — param validation", () => {
  it("valid userId calls domain", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app).get(`/users/${VALID_USER_ID}/profile`);

    expect(res.status).toBe(200);
    expect(domain.getProfile).toHaveBeenCalledWith(VALID_USER_ID);
  });

  it("empty userId falls through to 404 (not a route match)", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    // An empty segment doesn't match the :userId param pattern
    const res = await request(app).get("/users//profile");
    expect(res.status).not.toBe(200);
    expect(domain.getProfile).not.toHaveBeenCalled();
  });
});

describe("PUT /users/:userId/preferences — body validation", () => {
  it("rejects empty object as preferences body", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    // TravelPreferencesSchema requires userId in body — empty body should fail
    const res = await request(app)
      .put(`/users/${VALID_USER_ID}/preferences`)
      .send({});

    expect(res.status).toBe(400);
    expect(domain.updatePreferences).not.toHaveBeenCalled();
  });

  it("valid preferences payload calls domain", async () => {
    const domain = makeDomain();
    const app = createApp(domain);
    const res = await request(app)
      .put(`/users/${VALID_USER_ID}/preferences`)
      .send({ userId: VALID_USER_ID, preferredCurrency: "USD" });

    expect(res.status).toBe(200);
    expect(domain.updatePreferences).toHaveBeenCalledOnce();
  });
});
