/**
 * `rego_infer_input_schema` -- statically analyse Rego source and return
 * a JSON Schema describing every input.* field the policy reads.
 *
 * Uses `opa parse --format=json` to get the module AST, then walks the
 * tree for Ref nodes whose first term is the `input` var. String-keyed
 * path components become nested object properties; variable-keyed
 * components (array wildcards like `_`) mark the parent field as an
 * array type.
 *
 * The result is not a validation schema -- it cannot infer scalar types
 * without semantic analysis -- but it gives the complete set of fields a
 * policy touches, which is the correct starting point for writing
 * integration tests or setting up `opa check --schema`.
 */
import { stat } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { findRegoFiles } from '../../lib/rego-files.js';
import { err, ok } from '../../lib/errors.js';
import {
  mapSubprocessFailure,
  tryParseJson,
  validatePaths,
  withToolEnvelope,
} from '../../lib/tool-helpers.js';
import { v0CompatibleField } from '../_rego-version.js';

const RegoInferInputSchemaInput = {
  source: z
    .string()
    .optional()
    .describe('Inline Rego source to analyse. Mutually exclusive with paths.'),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Policy files or directories to analyse. Each must be inside an allowed root (OPA_MCP_ALLOWED_PATHS). Directories are walked recursively for *.rego files.',
    ),
  v0Compatible: v0CompatibleField,
};

interface OpaTerm {
  type: string;
  value: unknown;
}

interface SchemaNode {
  type?: 'object' | 'array';
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

export interface RegoInferInputSchemaOutput {
  /** JSON Schema draft-07 object describing the inferred input shape. */
  schema: object;
  /** Human-readable list of every input.* path found, e.g. ["input.action", "input.user.role"]. */
  inputPaths: string[];
  /** Number of .rego files analysed. */
  filesAnalyzed: number;
}

/**
 * Recursively walk an OPA parse AST (arbitrary JSON) and collect every
 * Ref whose first term is the `input` variable. Each collected ref is an
 * array of path parts: string for a named key, null for a variable/wildcard.
 */
function collectInputRefs(node: unknown, refs: Array<Array<string | null>>): void {
  if (node === null || node === undefined || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectInputRefs(item, refs);
    return;
  }

  const obj = node as Record<string, unknown>;

  if (obj['type'] === 'ref' && Array.isArray(obj['value'])) {
    const terms = obj['value'] as OpaTerm[];
    if (terms.length >= 2 && terms[0]?.type === 'var' && terms[0]?.value === 'input') {
      const path: Array<string | null> = [];
      for (let i = 1; i < terms.length; i++) {
        const t = terms[i];
        if (!t) break;
        if (t.type === 'string' && typeof t.value === 'string') {
          path.push(t.value);
        } else if (t.type === 'var') {
          path.push(null); // array wildcard (e.g. `_` or a named loop variable)
        } else {
          break; // computed/dynamic key -- cannot statically resolve
        }
      }
      if (path.length > 0) refs.push(path);
    }
  }

  for (const val of Object.values(obj)) {
    collectInputRefs(val, refs);
  }
}

/**
 * Insert a single input path into the growing schema tree.
 * A null part signals array access; everything else is an object key.
 */
function mergePath(node: SchemaNode, path: Array<string | null>, idx: number): void {
  if (idx >= path.length) return;
  const part: string | null | undefined = path[idx];

  if (part === null || part === undefined) {
    if (node.type !== 'array') {
      node.type = 'array';
      node.items = { type: 'object', properties: {} };
      delete node.properties;
    }
    if (idx + 1 < path.length && node.items) {
      mergePath(node.items, path, idx + 1);
    }
    return;
  }

  if (!node.properties) node.properties = {};
  if (node.type !== 'array') node.type = 'object';
  if (!node.properties[part]) node.properties[part] = {};
  if (idx + 1 < path.length) mergePath(node.properties[part], path, idx + 1);
}

function buildSchema(allPaths: Array<Array<string | null>>): object {
  const seen = new Set<string>();
  const root: SchemaNode = { type: 'object', properties: {} };
  for (const path of allPaths) {
    const key = JSON.stringify(path);
    if (!seen.has(key)) {
      seen.add(key);
      mergePath(root, path, 0);
    }
  }
  return { $schema: 'http://json-schema.org/draft-07/schema#', ...root };
}

function pathToString(path: Array<string | null>): string {
  return 'input.' + path.map((p) => (p === null ? '[]' : p)).join('.');
}

export function registerRegoInferInputSchema(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_infer_input_schema',
    {
      title: 'Infer input schema',
      description:
        'Statically analyse one or more Rego policies and return a JSON Schema (draft-07) object describing every input.* field the policies read. Uses opa parse for AST-level analysis -- no running OPA server required. Correct starting point for writing integration tests, configuring opa check --schema validation, or documenting a policy API. Accepts inline source, individual files, or directories (walked recursively for *.rego files).',
      inputSchema: RegoInferInputSchemaInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, paths, v0Compatible }, { signal }) => {
      return withToolEnvelope<RegoInferInputSchemaOutput>(config, async () => {
        if (source === undefined && (!paths || paths.length === 0)) {
          return err(
            'INVALID_INPUT',
            'rego_infer_input_schema requires either source or at least one path.',
          );
        }

        const allRefs: Array<Array<string | null>> = [];
        let filesAnalyzed = 0;
        /** Files that did not parse, named relative to the path they were found under. */
        const unparsed: string[] = [];
        let firstParseError = '';

        if (source !== undefined) {
          const result = await opa.parse({ source, v0Compatible }, signal);
          const failure = mapSubprocessFailure(result, 'opa');
          if (failure) return failure;
          if (result.exitCode !== 0) {
            return err('INVALID_REGO', 'opa parse failed -- check the policy for syntax errors.', {
              details: { stderr: result.stderr.trim() },
            });
          }
          const ast = tryParseJson(result.stdout);
          if (ast) collectInputRefs(ast, allRefs);
          filesAnalyzed = 1;
        } else {
          const validation = validatePaths(paths!, config, { mustExist: true });
          if (!validation.ok) return validation.error;

          const filePaths: Array<{ filePath: string; label: string }> = [];
          for (const p of validation.resolved) {
            const s = await stat(p);
            if (s.isDirectory()) {
              for (const f of await findRegoFiles(p)) {
                filePaths.push({ filePath: f, label: relative(p, f) });
              }
            } else {
              filePaths.push({ filePath: p, label: basename(p) });
            }
          }

          for (const { filePath, label } of filePaths) {
            const result = await opa.run(
              ['parse', '--format=json', ...(v0Compatible ? ['--v0-compatible'] : []), filePath],
              undefined,
              signal,
            );
            const failure = mapSubprocessFailure(result, 'opa');
            if (failure) return failure;
            // Skip files that fail to parse (e.g. test files with syntax issues)
            // rather than aborting the entire analysis, but say so: a pre-1.0
            // policy fails every file, and an empty schema would look like a
            // policy that reads no input.
            const ast = result.exitCode === 0 ? tryParseJson(result.stdout) : undefined;
            if (ast) {
              collectInputRefs(ast, allRefs);
              filesAnalyzed++;
            } else {
              unparsed.push(label);
              firstParseError ||= result.stderr.trim();
            }
          }
        }

        const preV1Hint = v0Compatible
          ? ''
          : ' If they are pre-1.0 Rego (rules without `if`), set `v0Compatible`.';
        // With nothing parsed there is no schema to infer, and an empty one
        // would read as a policy that takes no input.
        if (filesAnalyzed === 0 && unparsed.length > 0) {
          return err(
            'INVALID_REGO',
            `No policy file parsed, so there is nothing to infer a schema from: ${unparsed.join(', ')}.`,
            {
              hint: `Fix the syntax at the line opa names.${preV1Hint}`,
              details: { stderr: firstParseError },
            },
          );
        }

        const schema = buildSchema(allRefs);

        const seen = new Set<string>();
        const inputPaths: string[] = [];
        for (const p of allRefs) {
          const s = pathToString(p);
          if (!seen.has(s)) {
            seen.add(s);
            inputPaths.push(s);
          }
        }
        inputPaths.sort();

        const warnings: string[] = [];
        if (unparsed.length > 0) {
          warnings.push(
            `${unparsed.length} file(s) did not parse and were left out: ${unparsed.join(', ')}.${preV1Hint}`,
          );
        }
        if (inputPaths.length === 0) {
          warnings.push(
            unparsed.length > 0
              ? 'No input.* references found in the files that parsed.'
              : 'No input.* references found. The policy may not read from input at all, or may use dynamic keys (e.g. input[key]) that cannot be statically resolved.',
          );
        }

        return ok<RegoInferInputSchemaOutput>({ schema, inputPaths, filesAnalyzed }, warnings);
      });
    },
  );
}
