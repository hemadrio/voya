/**
 * Mailer interface — injectable for testing and multi-environment support.
 *
 * The production implementation would delegate to @aws-sdk/client-ses.
 * The console stub logs to stdout and is used in development and tests.
 * Mailer failures after a committed transaction must be logged and retried;
 * they must never surface as request failures.
 *
 * WO-020: added sendVerificationEmail and sendRegistrationAttemptNotice,
 * plus InMemoryMailer capture implementation for tests.
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

export interface VerificationEmailParams {
  to: string;
  /** Raw (unhashed) verification token — logged only in dev console, never in prod. */
  verificationToken: string;
  expiresInMinutes: number;
}

export interface RegistrationAttemptNoticeParams {
  /** Email of the already-verified account that received a duplicate register attempt. */
  to: string;
}

export interface Mailer {
  sendPasswordResetLink(params: PasswordResetMailParams): Promise<void>;
  sendPasswordChangedNotice(params: PasswordChangedMailParams): Promise<void>;
  sendVerificationEmail(params: VerificationEmailParams): Promise<void>;
  sendRegistrationAttemptNotice(params: RegistrationAttemptNoticeParams): Promise<void>;
}

// ---------------------------------------------------------------------------
// Console stub — used in development (NODE_ENV=development)
// ---------------------------------------------------------------------------

export function createConsoleMailer(logger?: {
  warn(obj: Record<string, unknown>, msg: string): void;
}): Mailer {
  function warnOutsideDev() {
    if (process.env["NODE_ENV"] !== "development") {
      logger?.warn(
        { event: "mailer.console_stub_used_outside_dev" },
        "ConsoleMailer used outside development — configure a real mailer",
      );
    }
  }

  return {
    async sendPasswordResetLink({ to, expiresInMinutes }) {
      warnOutsideDev();
      // Token value is NOT logged — only metadata.
      console.log(
        `[ConsoleMailer] Password reset link for ${to}: expires in ${expiresInMinutes}m (token not logged)`,
      );
    },

    async sendPasswordChangedNotice({ to }) {
      warnOutsideDev();
      console.log(`[ConsoleMailer] Password changed notice sent to ${to}`);
    },

    async sendVerificationEmail({ to, verificationToken, expiresInMinutes }) {
      warnOutsideDev();
      // In dev, the token IS shown so developers can verify without email.
      if (process.env["NODE_ENV"] === "development") {
        console.log(
          `[ConsoleMailer] Verification email for ${to}: token=${verificationToken} expires=${expiresInMinutes}m`,
        );
      } else {
        console.log(
          `[ConsoleMailer] Verification email for ${to}: expires in ${expiresInMinutes}m (token not logged)`,
        );
      }
    },

    async sendRegistrationAttemptNotice({ to }) {
      warnOutsideDev();
      console.log(`[ConsoleMailer] Registration attempt notice sent to ${to} (account already verified)`);
    },
  };
}

// ---------------------------------------------------------------------------
// InMemoryMailer — captures sent messages for test assertions
// ---------------------------------------------------------------------------

export interface SentVerificationEmail {
  to: string;
  verificationToken: string;
  expiresInMinutes: number;
}

export interface SentRegistrationAttemptNotice {
  to: string;
}

export interface SentPasswordReset {
  to: string;
  resetToken: string;
  expiresInMinutes: number;
}

/** Capture implementation for tests — never sends real email. */
export class InMemoryMailer implements Mailer {
  readonly verificationEmails: SentVerificationEmail[] = [];
  readonly registrationAttemptNotices: SentRegistrationAttemptNotice[] = [];
  readonly passwordResets: SentPasswordReset[] = [];
  readonly passwordChangedNotices: string[] = [];

  async sendVerificationEmail(params: VerificationEmailParams): Promise<void> {
    this.verificationEmails.push({
      to: params.to,
      verificationToken: params.verificationToken,
      expiresInMinutes: params.expiresInMinutes,
    });
  }

  async sendRegistrationAttemptNotice(params: RegistrationAttemptNoticeParams): Promise<void> {
    this.registrationAttemptNotices.push({ to: params.to });
  }

  async sendPasswordResetLink(params: PasswordResetMailParams): Promise<void> {
    this.passwordResets.push({
      to: params.to,
      resetToken: params.resetToken,
      expiresInMinutes: params.expiresInMinutes,
    });
  }

  async sendPasswordChangedNotice(params: PasswordChangedMailParams): Promise<void> {
    this.passwordChangedNotices.push(params.to);
  }

  /** Clear all captured messages. */
  reset(): void {
    this.verificationEmails.length = 0;
    this.registrationAttemptNotices.length = 0;
    this.passwordResets.length = 0;
    this.passwordChangedNotices.length = 0;
  }
}
