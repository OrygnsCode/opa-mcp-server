/**
 * `rego_check_schema` -- validate that a Rego policy's input.* references
 * are consistent with a JSON Schema.
 *
 * Wraps `opa check --schema` to add schema-aware type checking on top of the
 * standard AST check: every `input.*` field the policy reads must exist in the
 * provided schema. Fields referenced in the policy but absent from the schema
 * surface as rego_type_error diagnostics with file/line locations.
 *
 * Accepts the schema inline (a JSON Schema object) or as a file path on disk.
 * Inline schemas are written to a temporary file via mkdtemp (atomic creation)
 * and cleaned up unconditionally after the subprocess completes.
 *
 * Designed to close the loop with rego_infer_input_schema: call
 * rego_infer_input_schema to derive the schema from policy A, then pass its
 * output directly as `inlineSchema` here to validate policy B against it.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import type { ToolEnvelope } from '../../types.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import {
  mapSubprocessFailure,
  sanitizeInlinePath,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';
import { v0CompatibleField } from '../_rego-version.js';

const RegoCheckSchemaInput = {
  source: z
    .string()
    .optional()
    .describe(
      'Inline Rego source to validate against the schema. Mutually exclusive with `paths`.',
    ),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Filesystem paths to policy files or directories to validate. Each path must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). Mutually exclusive with `source`.',
    ),
  inlineSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'JSON Schema (draft-07) object describing the expected shape of the `input` document. Mutually exclusive with `schemaPath`. Accepts the `schema` field from `rego_infer_input_schema` output directly.',
    ),
  schemaPath: z
    .string()
    .optional()
    .describe(
      'Path to a JSON Schema file on disk to use for `input` validation, or to a schema directory when the policy carries `# METADATA` / `schemas:` annotations naming files in it (opa reads a directory only through those). Must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). Mutually exclusive with `inlineSchema`.',
    ),
  strict: z
    .boolean()
    .optional()
    .describe(
      'Enable strict mode -- also fail on unused variables, deprecated builtins, and other non-fatal issues in addition to schema violations.',
    ),
  v0Compatible: v0CompatibleField,
};

interface CheckErrorRecord {
  message?: string;
  code?: string;
  location?: { file?: string; row?: number; col?: number };
}

export interface RegoCheckSchemaOutput {
  /** Whether the policy passes schema-aware type checking. */
  valid: boolean;
  /** Structured diagnostics. Empty when `valid` is true. */
  errors: CheckErrorRecord[];
}

/**
 * Whether the source carries a `# METADATA` comment block with a `schemas:`
 * entry, the one way opa reads a schema directory: each entry names a file
 * in it for a path in `input` or `data`.
 */
export function declaresSchemas(source: string): boolean {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\s*METADATA\b/.test(lines[i]!)) continue;
    for (let j = i + 1; j < lines.length && /^\s*#/.test(lines[j]!); j++) {
      if (/^\s*#\s*schemas\s*:/.test(lines[j]!)) return true;
    }
  }
  return false;
}

/**
 * Whether any policy under `paths` carries a `schemas:` annotation, as OPA
 * itself reads it. Asking opa keeps this tool from reading policy files on
 * its own. A path opa cannot load leaves the answer open (`undefined`), for
 * opa check to report why: counting it as carrying none turned a policy that
 * does not parse, such as a pre-1.0 one read as v1, into that complaint.
 */
async function anyPathDeclaresSchemas(
  opa: OpaCli,
  paths: readonly string[],
  v0Compatible: boolean | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean | undefined | ToolEnvelope<never>> {
  let unloaded = false;
  for (const target of paths) {
    const result = await opa.inspect({ target, v0Compatible }, signal);
    const failure = mapSubprocessFailure(result, 'opa');
    if (failure) return failure;
    if (result.exitCode !== 0) {
      unloaded = true;
      continue;
    }
    const parsed = tryParseJson<{
      annotations?: Array<{ annotations?: { schemas?: unknown } }>;
    }>(result.stdout);
    const declared = (parsed?.annotations ?? []).some(
      (entry) => Array.isArray(entry.annotations?.schemas) && entry.annotations.schemas.length > 0,
    );
    if (declared) return true;
  }
  return unloaded ? undefined : false;
}

/**
 * Whether a schema says nothing opa can check a reference against: no
 * properties and nothing that brings any in. opa then accepts every `input`
 * reference, even with `additionalProperties: false`. An inferred schema comes
 * out like this when no policy file could be read.
 */
export function constrainsNothing(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  const properties = s['properties'];
  const hasProperties =
    typeof properties === 'object' && properties !== null && Object.keys(properties).length > 0;
  const composed = ['$ref', 'allOf', 'anyOf', 'oneOf', 'items', 'patternProperties'].some(
    (k) => k in s,
  );
  return !hasProperties && !composed;
}

export function registerRegoCheckSchema(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_check_schema',
    {
      title: 'Check Rego against a JSON Schema',
      description:
        "Validate that a Rego policy's input.* field references are consistent with a JSON Schema using `opa check --schema`. Every field the policy reads from `input` must exist in the schema; mismatches surface as rego_type_error diagnostics with file/line locations. Returns `{ valid: true, errors: [] }` when all references match the schema, or `{ valid: false, errors: [...] }` with structured diagnostics when they do not. Accepts the schema inline (pass the `schema` output of `rego_infer_input_schema` directly as `inlineSchema`) or as a path to a JSON Schema file on disk, or to a schema directory when the policy declares `schemas:` annotations (`schemaPath`). Provide `source` for inline Rego or `paths` for file/directory checking.",
      inputSchema: RegoCheckSchemaInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, paths, inlineSchema, schemaPath, strict, v0Compatible }, { signal }) => {
      return withToolEnvelope<RegoCheckSchemaOutput>(config, async () => {
        // ── Policy input validation ─────────────────────────────────────
        if (!source && !paths?.length) {
          return err(
            'INVALID_INPUT',
            'rego_check_schema requires either `source` or at least one entry in `paths`.',
          );
        }
        if (source && paths?.length) {
          return err(
            'INVALID_INPUT',
            'rego_check_schema does not accept both `source` and `paths` -- pass one or the other.',
          );
        }

        // ── Schema input validation ─────────────────────────────────────
        if (!inlineSchema && !schemaPath) {
          return err(
            'INVALID_INPUT',
            'rego_check_schema requires either `inlineSchema` (a JSON Schema object) or `schemaPath` (a path to a schema file on disk).',
          );
        }
        if (inlineSchema && schemaPath) {
          return err(
            'INVALID_INPUT',
            'rego_check_schema does not accept both `inlineSchema` and `schemaPath` -- pass one or the other.',
          );
        }

        // ── Policy path resolution ──────────────────────────────────────
        let resolvedPaths: string[] | undefined;
        if (paths?.length) {
          const validation = validatePaths(paths, config, { mustExist: true });
          if (!validation.ok) return validation.error;
          resolvedPaths = validation.resolved;
        }

        // ── Schema path resolution ──────────────────────────────────────
        let resolvedSchemaFile: string | undefined;
        if (schemaPath) {
          const v = validatePaths([schemaPath], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedSchemaFile = v.resolved[0];
          // opa accepts a directory here, but reads from it only where the
          // policy carries schema annotations naming files in it. Without
          // those a directory checked nothing and came back valid.
          if ((await stat(resolvedSchemaFile!)).isDirectory()) {
            const annotated =
              source !== undefined
                ? declaresSchemas(source)
                : await anyPathDeclaresSchemas(opa, resolvedPaths ?? [], v0Compatible, signal);
            if (typeof annotated === 'object') return annotated;
            if (annotated === false) {
              return err(
                'INVALID_INPUT',
                'schemaPath is a directory, which opa reads only where the policy carries `schemas:` annotations naming files in it; this policy carries none, so nothing would be checked.',
                {
                  hint: 'Pass the schema file directly, supply it as inlineSchema, or annotate the policy with a `# METADATA` block whose `schemas:` entry names a file in the directory.',
                  details: { schemaPath },
                },
              );
            }
          }
        }

        // ── Inline schema: write to a temp file, clean up unconditionally ─
        let tempDir: string | undefined;
        try {
          if (inlineSchema !== undefined) {
            tempDir = await mkdtemp(join(tmpdir(), 'orygn-schema-'));
            const schemaFile = join(tempDir, 'schema.json');
            await writeFile(schemaFile, JSON.stringify(inlineSchema), 'utf8');
            resolvedSchemaFile = schemaFile;
          }

          // ── Run opa check ─────────────────────────────────────────────
          const result = await opa.check(
            {
              source,
              paths: resolvedPaths,
              strict,
              schemaDir: resolvedSchemaFile,
              v0Compatible,
            },
            signal,
          );

          const subprocessFailure = mapSubprocessFailure(result, 'opa');
          if (subprocessFailure) return subprocessFailure;

          if (result.exitCode === 0) {
            return ok<RegoCheckSchemaOutput>(
              { valid: true, errors: [] },
              inlineSchema !== undefined && constrainsNothing(inlineSchema)
                ? [
                    'The schema names no properties, so opa accepts every `input` reference against it and nothing was checked. A schema from rego_infer_input_schema comes out like this when it could not read the policy; see the warnings it gave.',
                  ]
                : undefined,
            );
          }

          // `opa check --format=json` writes diagnostics to stderr.
          const parsed = tryParseJson<{ errors?: CheckErrorRecord[] }>(result.stderr);
          if (!parsed) {
            return err(
              'INVALID_REGO',
              'opa check exited non-zero but produced no parseable diagnostics.',
              { details: { stderr: result.stderr.trim(), stdout: result.stdout.trim() } },
            );
          }

          const rawErrors = parsed.errors ?? [];
          // When source was provided inline, OPA references a temp .rego path in
          // error locations. Replace those paths with the sentinel <inline> so
          // callers see a stable, meaningful location instead of an ephemeral path.
          const errors =
            source !== undefined
              ? rawErrors.map((e) =>
                  e.location?.file
                    ? {
                        ...e,
                        location: { ...e.location, file: sanitizeInlinePath(e.location.file) },
                      }
                    : e,
                )
              : rawErrors;

          return ok<RegoCheckSchemaOutput>({ valid: false, errors });
        } finally {
          if (tempDir !== undefined) {
            await rm(tempDir, { recursive: true, force: true });
          }
        }
      });
    },
  );
}
