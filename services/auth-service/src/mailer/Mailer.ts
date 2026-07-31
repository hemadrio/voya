/**
 * Mailer interface — injectable for testing and multi-environment support.
 *
 * The production implementation would delegate to @aws-sdk/client-ses.
 * The console stub logs to stdout and is used in development and tests.
 * Mailer failures after a committed transaction must be logged and retried;
 * they must never surface as request failures.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PasswordResetMailParams {
  to: string;
  resetToken: string;
  expiresInMinutes: number;
}

export interface PasswordChangedMailParams {
  to: string;
}

export interface Mailer {
  sendPasswordResetLink(params: PasswordResetMailParams): Promise<void>;
  sendPasswordChangedNotice(params: PasswordChangedMailParams): Promise<void>;
}

// ---------------------------------------------------------------------------
// Console stub — used in development (NODE_ENV=development)
// ---------------------------------------------------------------------------

export function createConsoleMailer(logger?: {
  warn(obj: Record<string, unknown>, msg: string): void;
}): Mailer {
  return {
    async sendPasswordResetLink({ to, expiresInMinutes }) {
      // Relaxed dev mode: only active when NODE_ENV=development.
      // No token value is logged — only metadata.
      if (process.env["NODE_ENV"] !== "development") {
        logger?.warn(
          { event: "mailer.console_stub_used_outside_dev", to: "[redacted]" },
          "ConsoleMailer used outside development — configure a real mailer",
        );
      }
      console.log(
        `[ConsoleMailer] Password reset link for ${to}: expires in ${expiresInMinutes}m (token not logged)`,
      );
    },

    async sendPasswordChangedNotice({ to }) {
      if (process.env["NODE_ENV"] !== "development") {
        logger?.warn(
          { event: "mailer.console_stub_used_outside_dev" },
          "ConsoleMailer used outside development",
        );
      }
      console.log(`[ConsoleMailer] Password changed notice sent to ${to}`);
    },
  };
}
