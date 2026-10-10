/** Why foxplug refused. Callers can switch on `code`. Messages never hold a secret. */
export type PlugErrorCode =
  | "bad-manifest" | "unknown-key" | "bad-host" | "bad-path" | "bad-template" | "bad-auth"
  | "bad-scope" | "bad-header";

export class PlugError extends Error {
  readonly code: PlugErrorCode;
  constructor(code: PlugErrorCode, message: string) {
    super(message);
    this.name = "PlugError";
    this.code = code;
  }
}

export const fail = (code: PlugErrorCode, message: string): never => {
  throw new PlugError(code, message);
};
