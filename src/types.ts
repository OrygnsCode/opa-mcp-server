/**
 * Shared types used across tools, prompts, and resources.
 */

/** Standard error codes returned by tools. */
export type ToolErrorCode =
  | 'INVALID_INPUT'
  | 'OPA_BINARY_NOT_FOUND'
  | 'REGAL_NOT_FOUND'
  | 'REGAL_VERSION_TOO_OLD'
  | 'CONFTEST_NOT_FOUND'
  | 'INVALID_REGO'
  | 'INVALID_BUNDLE'
  | 'EVAL_ERROR'
  | 'PATH_NOT_ALLOWED'
  | 'PATH_NOT_FOUND'
  | 'OPA_UNREACHABLE'
  | 'OPA_AUTH_FAILED'
  | 'POLICY_NOT_FOUND'
  | 'DATA_NOT_FOUND'
  | 'DEPENDENCY_CONFLICT'
  | 'NO_TESTS_FOUND'
  | 'COVERAGE_BELOW_THRESHOLD'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'VERIFY_INCONCLUSIVE'
  | 'Z3_INIT_ERROR'
  | 'OPA_VERSION_UNSUPPORTED'
  | 'GITHUB_TOKEN_MISSING'
  | 'GIST_CREATE_FAILED'
  | 'UNKNOWN_ERROR';

/** Structured error payload. */
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  hint?: string;
  details?: unknown;
}

/**
 * Standard envelope returned by every tool. The MCP SDK wraps this as
 * `{ content: [{ type: 'text', text: JSON.stringify(envelope) }] }`.
 */
export interface ToolEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ToolError;
  warnings?: string[];
  truncated?: boolean;
}
