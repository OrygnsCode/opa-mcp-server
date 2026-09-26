/**
 * A conftest run that printed no results failed before evaluating anything.
 * When the reason is in the policy (OPA's `rego_*_error` codes), that is the
 * caller's Rego to fix, not an unknown failure of the tool.
 */
import { err } from '../../lib/errors.js';
import type { ToolEnvelope } from '../../types.js';
import { PRE_V1_SYNTAX } from '../_rego-version.js';

export function conftestFailure(
  command: 'test' | 'verify',
  exitCode: number | null,
  stdout: string,
  stderr: string,
  v0Compatible: boolean | undefined,
): ToolEnvelope<never> {
  const detail = stderr.trim() || stdout.trim();
  const message = `conftest ${command} failed with exit code ${exitCode}: ${detail || 'no output'}`;
  const details = { exitCode, stderr: stderr.trim() };
  if (/rego_[a-z_]+_error/.test(detail)) {
    return err('INVALID_REGO', message, {
      hint:
        !v0Compatible && PRE_V1_SYNTAX.test(detail)
          ? 'The policy looks like pre-1.0 Rego, which conftest reads as v1 by default. Set `v0Compatible`, or migrate it with rego_migrate_v1.'
          : 'Fix the policy at the file and line named; rego_check gives structured diagnostics.',
      details,
    });
  }
  return err('UNKNOWN_ERROR', message, { details });
}
