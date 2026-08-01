/**
 * Global setup: sign in as the synthetic test traveler and save the
 * storage state so journey suites can reuse it without repeating sign-in.
 *
 * Runs as the "setup" Playwright project before checkout, cancellation,
 * and assistant suites.
 */

import { test as setup } from "@playwright/test";
import { signInAsSyntheticUser, AUTH_STATE_PATH } from "./storage-state.js";
import fs from "fs";
import path from "path";

setup("authenticate as synthetic traveler", async ({ page }) => {
  // Ensure the .auth directory exists
  const authDir = path.dirname(AUTH_STATE_PATH);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  await signInAsSyntheticUser(page);

  // Persist authenticated browser state for reuse by journey suites
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
