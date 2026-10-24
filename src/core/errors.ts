/** Error types shared by the server, providers and CLI. */

export interface ErrorDetails {
  statusCode: number;
  type: string;
  code: string;
  hint?: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly type: string;
  readonly code: string;
  readonly hint?: string;

  constructor(message: string, details: Partial<ErrorDetails> = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = details.statusCode ?? 500;
    this.type = details.type ?? "server_error";
    this.code = details.code ?? "internal_error";
    if (details.hint) this.hint = details.hint;
  }
}

/** The saved browser profile is not logged in (or the chat UI changed). */
export class LoginRequiredError extends AppError {
  constructor(message: string, hint?: string) {
    super(message, {
      statusCode: 401,
      type: "invalid_request_error",
      code: "login_required",
      hint,
    });
  }
}

/** The provider's web UI reported "server busy"; safe to retry. */
export class ServerBusyError extends AppError {
  constructor(message = "provider is busy") {
    super(message, { statusCode: 503, type: "server_error", code: "provider_busy" });
  }
}

export class ProviderError extends AppError {
  constructor(message: string, statusCode = 502, hint?: string) {
    super(message, { statusCode, type: "server_error", code: "provider_error", hint });
  }
}

export class RequestAbortedError extends AppError {
  constructor(message = "client closed the request") {
    super(message, { statusCode: 499, type: "invalid_request_error", code: "request_aborted" });
  }
}

export class QueueFullError extends AppError {
  constructor(message = "too many queued requests") {
    super(message, { statusCode: 429, type: "server_error", code: "queue_full" });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "invalid api key") {
    super(message, { statusCode: 401, type: "invalid_request_error", code: "invalid_api_key" });
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, { statusCode: 400, type: "invalid_request_error", code: "invalid_request" });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Normalise anything thrown into an OpenAI-style error body. */
export function toErrorBody(error: unknown): {
  statusCode: number;
  body: { error: { message: string; type: string; code: string; hint?: string } };
} {
  if (isAppError(error)) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          message: error.message,
          type: error.type,
          code: error.code,
          ...(error.hint ? { hint: error.hint } : {}),
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    statusCode: 500,
    body: { error: { message, type: "server_error", code: "internal_error" } },
  };
}
