// Error types for the editor API.
//
// Kept in its own file (zero dependencies) so that consumers like
// claude-tools.ts can import the error class for `instanceof` checks
// without transitively pulling in tool instances, render modules, or
// the rest of the API surface.

/**
 * Structured error thrown by editor API methods on validation failure.
 *
 * `code` is a stable machine-readable identifier (e.g. `OUT_OF_BOUNDS`),
 * `context` is a JSON-serializable bag of details. The dispatch layer
 * (claude-tools.ts) preserves both fields when surfacing errors to the LLM.
 */
export class ApiValidationError extends Error {
  code: string;
  context: Record<string, unknown>;
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiValidationError';
    this.code = code;
    this.context = context;
  }
}
