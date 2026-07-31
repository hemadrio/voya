/**
 * Environment variable validation.
 *
 * Parses and validates process.env with a Zod schema at module load time.
 * Import this module early (e.g. in next.config.js) so missing variables
 * abort startup with a clear, actionable message rather than a silent
 * runtime failure at first request.
 */

import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z
    .string({ required_error: "NEXT_PUBLIC_API_BASE_URL is required" })
    .url({ message: "NEXT_PUBLIC_API_BASE_URL must be a valid URL" }),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

function parseEnv() {
  const result = envSchema.safeParse({
    NEXT_PUBLIC_API_BASE_URL: process.env["NEXT_PUBLIC_API_BASE_URL"],
    NODE_ENV: process.env["NODE_ENV"],
  });

  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `[env] Application startup aborted — missing or invalid environment variables:\n${missing}\n\nSet the required variables in .env.local and restart the dev server.`,
    );
  }

  return result.data;
}

export const env = parseEnv();

export type Env = z.infer<typeof envSchema>;
