import { describe, it, expect } from "vitest";
import {
  LoginSchema,
  RegisterSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from "@/lib/validation/auth";

describe("LoginSchema", () => {
  it("accepts valid credentials", () => {
    const result = LoginSchema.safeParse({ email: "user@example.com", password: "secret" });
    expect(result.success).toBe(true);
  });

  it("rejects empty email", () => {
    const result = LoginSchema.safeParse({ email: "", password: "secret" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = LoginSchema.safeParse({ email: "not-an-email", password: "secret" });
    expect(result.success).toBe(false);
  });

  it("rejects empty password", () => {
    const result = LoginSchema.safeParse({ email: "user@example.com", password: "" });
    expect(result.success).toBe(false);
  });

  it("normalises email to lowercase", () => {
    const result = LoginSchema.safeParse({ email: "  USER@EXAMPLE.COM  ", password: "pw" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("user@example.com");
  });
});

describe("RegisterSchema", () => {
  const valid = {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    password: "Password1",
    confirmPassword: "Password1",
    locale: "en",
  };

  it("accepts valid registration", () => {
    expect(RegisterSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects mismatched passwords", () => {
    const result = RegisterSchema.safeParse({ ...valid, confirmPassword: "Different1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs).toContain("Passwords do not match");
    }
  });

  it("rejects password without uppercase", () => {
    const result = RegisterSchema.safeParse({ ...valid, password: "nouppercase1", confirmPassword: "nouppercase1" });
    expect(result.success).toBe(false);
  });

  it("rejects password without number", () => {
    const result = RegisterSchema.safeParse({ ...valid, password: "NoNumbers!", confirmPassword: "NoNumbers!" });
    expect(result.success).toBe(false);
  });

  it("rejects password shorter than 8 chars", () => {
    const result = RegisterSchema.safeParse({ ...valid, password: "Ab1", confirmPassword: "Ab1" });
    expect(result.success).toBe(false);
  });

  it("rejects empty firstName", () => {
    const result = RegisterSchema.safeParse({ ...valid, firstName: "" });
    expect(result.success).toBe(false);
  });

  it("rejects firstName longer than 64 chars", () => {
    const result = RegisterSchema.safeParse({ ...valid, firstName: "A".repeat(65) });
    expect(result.success).toBe(false);
  });
});

describe("ForgotPasswordSchema", () => {
  it("accepts valid email", () => {
    expect(ForgotPasswordSchema.safeParse({ email: "user@example.com" }).success).toBe(true);
  });

  it("rejects invalid email", () => {
    expect(ForgotPasswordSchema.safeParse({ email: "bad" }).success).toBe(false);
  });
});

describe("ResetPasswordSchema", () => {
  const valid = {
    token: "reset-token-abc",
    password: "NewPassword1",
    confirmPassword: "NewPassword1",
  };

  it("accepts valid reset", () => {
    expect(ResetPasswordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty token", () => {
    expect(ResetPasswordSchema.safeParse({ ...valid, token: "" }).success).toBe(false);
  });

  it("rejects mismatched passwords", () => {
    const result = ResetPasswordSchema.safeParse({ ...valid, confirmPassword: "Mismatch1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message === "Passwords do not match")).toBe(true);
    }
  });
});
