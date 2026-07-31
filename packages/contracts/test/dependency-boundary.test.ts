import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRuntimeDependencyIsZodOnly,
  findForbiddenDependencies,
} from "../scripts/check-dependency-boundary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

describe("dependency boundary", () => {
  it("declares zod as the only runtime dependency", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
    expect(() => assertRuntimeDependencyIsZodOnly(pkg)).not.toThrow();
  });

  it("does not depend on express, @prisma/client, stripe, @anthropic-ai/sdk, or any AWS SDK", () => {
    expect(findForbiddenDependencies(pkg)).toEqual([]);
  });

  it("fails when a forbidden dependency is present in the manifest (regression guard for the assertion itself)", () => {
    const poisoned = { ...pkg, dependencies: { ...pkg.dependencies, express: "^4.19.0" } };
    expect(findForbiddenDependencies(poisoned)).toEqual(["dependencies.express"]);
    expect(() => assertRuntimeDependencyIsZodOnly(poisoned)).toThrow();
  });

  it("flags any @aws-sdk/* scoped package", () => {
    const poisoned = { ...pkg, dependencies: { ...pkg.dependencies, "@aws-sdk/client-s3": "^3.0.0" } };
    expect(findForbiddenDependencies(poisoned)).toEqual(["dependencies.@aws-sdk/client-s3"]);
  });

  it("is not marked private, so it is resolvable/publishable as a workspace package", () => {
    expect(pkg.private).toBe(false);
  });

  it("declares the @travel/contracts package name", () => {
    expect(pkg.name).toBe("@travel/contracts");
  });
});
