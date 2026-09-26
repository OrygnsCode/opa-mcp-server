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

/** A data file: it carries no annotations, and opa inspect cannot read one. */
const DATA_FILE = /\.(json|ya?ml)$/i;

/**
 * Whether any policy under `paths` carries a `schemas:` annotation, as OPA
 * itself reads it. Asking opa keeps this tool from reading policy files on
 * its own. A policy that does not parse leaves the answer open (`undefined`),
 * for opa check to report as a diagnostic: counting it as carrying none turned
 * a pre-1.0 policy read as v1 into that complaint. Any other failure to read
 * the annotations is an error, since opa check would pass without them and
 * without reading the schema directory.
 */
async function anyPathDeclaresSchemas(
  opa: OpaCli,
  paths: readonly string[],
  v0Compatible: boolean | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean | undefined | ToolEnvelope<never>> {
  let unparsed = false;
  for (const target of paths) {
    if (DATA_FILE.test(target) && !(await stat(target)).isDirectory()) continue;
    const result = await opa.inspect({ target, v0Compatible }, signal);
    const failure = mapSubprocessFailure(result, 'opa');
    if (failure) return failure;
    if (result.exitCode !== 0) {
      const output = `${result.stderr}\n${result.stdout}`.trim();
      if (/rego_[a-z_]+_error/.test(output)) {
        unparsed = true;
        continue;
      }
      return err(
        'INVALID_INPUT',
        `opa could not read the annotations under ${target}, so it is not known whether the schema directory would be read: ${output.split(/\r?\n/)[0]}`,
        {
          hint: 'Pass the schema file directly, or supply it as inlineSchema.',
          details: { output },
        },
      );
    }
    const parsed = tryParseJson<{
      annotations?: Array<{ annotations?: { schemas?: unknown } }>;
    }>(result.stdout);
    const declared = (parsed?.annotations ?? []).some(
      (entry) => Array.isArray(entry.annotations?.schemas) && entry.annotations.schemas.length > 0,
    );
    if (declared) return true;
  }
  return unparsed ? undefined : false;
}

/** A policy whose one reference names a field no schema would. */
const PROBE = 'package q__probe\n\nimport rego.v1\n\np if input.q__no_such_field == 1\n';

/**
 * Whether opa, checking against this schema, lets through a reference to an
 * `input` field the schema does not name. It does for a schema with no
 * `properties`, and for keywords its checker ignores, such as `oneOf` and
 * `patternProperties`; asking opa beats keeping a list of those.
 */
async function acceptsUnknownFields(
  opa: OpaCli,
  schemaFile: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const probe = await opa.check({ source: PROBE, schemaDir: schemaFile }, signal);
  return mapSubprocessFailure(probe, 'opa') === undefined && probe.exitCode === 0;
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
            // A directory is read through annotations, each naming its own file.
            const schemaIsFile =
              resolvedSchemaFile !== undefined && !(await stat(resolvedSchemaFile)).isDirectory();
            return ok<RegoCheckSchemaOutput>(
              { valid: true, errors: [] },
              schemaIsFile && (await acceptsUnknownFields(opa, resolvedSchemaFile!, signal))
                ? [
                    'The schema lets through `input` fields it does not name, so a reference to one that does not exist, such as a misspelling, passes. A schema from rego_infer_input_schema is like this when it could not read the policy.',
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
