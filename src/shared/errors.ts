/**
 * Errors serialize to a flat contract: { "code": "snake_case_reason", "message": "..." }.
 * Clients switch on `code`; `message` is for logs. This mirrors the Quietletter cloud
 * wire contract so a client can talk to either backend unchanged.
 */

export interface ErrorBody {
    code: string;
    message: string;
}

export class ApiError extends Error {
    public readonly statusCode: number;
    public readonly code: string;

    constructor(statusCode: number, code: string, message?: string) {
        super(message ?? code);
        this.name = new.target.name;
        this.statusCode = statusCode;
        this.code = code;
    }

    get body(): ErrorBody {
        return { code: this.code, message: this.message };
    }
}

/** 400 — invalid input. `code` is machine-readable, e.g. `invalid_id`. */
export class ValidationError extends ApiError {
    constructor(code: string, message?: string) {
        super(400, code, message);
    }
}

/** 401 — authentication required / owner token invalid. */
export class AuthError extends ApiError {
    constructor(code = 'unauthenticated', message?: string) {
        super(401, code, message);
    }
}

/** 404 — resource not found. */
export class NotFoundError extends ApiError {
    constructor(code = 'not_found', message?: string) {
        super(404, code, message);
    }
}

/** 409 — conflict (e.g. a switch id already owned under different terms). */
export class ConflictError extends ApiError {
    constructor(code: string, message?: string) {
        super(409, code, message);
    }
}
