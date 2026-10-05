/**
 * `rego_infer_input_schema` -- statically analyse Rego source and return
 * a JSON Schema describing every input.* field the policy reads.
 *
 * Uses `opa parse --format=json` for the module ASTs and `inputShape` to
 * follow the bindings a policy reads input through: loop variables, rules
 * whose value is an input path, function parameters and `object.get` keys.
 * A key the policy computes is left open (`additionalProperties` and
 * `items`), and a scalar type is set only where the policy shows it, by a
 * comparison with a literal, an `is_*` check or a string built-in.
 */
import { stat } from 'node:fs/promises';
import { basename, relative } from 'node:path';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { ANY, inputShape, type InputPath, type ScalarType } from '../../lib/input-shape.js';
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

interface SchemaNode {
  type?: ScalarType;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: SchemaNode;
}

export interface RegoInferInputSchemaOutput {
  /** JSON Schema draft-07 object describing the inferred input shape. */
  schema: object;
  /**
   * Every input path found, e.g. `input.user.role` or
   * `input.request.object.spec.containers[].image`. `[]` is an array element,
   * `[*]` any key or element.
   */
  inputPaths: string[];
  /** Number of .rego files analysed. */
  filesAnalyzed: number;
}

/** Insert one input path into the schema tree. */
function mergePath(node: SchemaNode, path: InputPath, idx: number): SchemaNode | undefined {
  if (idx >= path.length) return node;
  const part = path[idx];
  if (part === null) {
    node.type = 'array';
    node.items ??= {};
    return mergePath(node.items, path, idx + 1);
  }
  if (part === ANY) {
    // Any key or element: open in both shapes, since the policy does not say which.
    node.items ??= node.additionalProperties ?? {};
    node.additionalProperties = node.items;
    return mergePath(node.items, path, idx + 1);
  }
  node.properties ??= {};
  if (node.type !== 'array') node.type = 'object';
  node.properties[part!] ??= {};
  return mergePath(node.properties[part!]!, path, idx + 1);
}

function buildSchema(paths: InputPath[], types: Map<string, Set<ScalarType>>): object {
  const root: SchemaNode = { type: 'object', properties: {} };
  const nodes = new Map<string, SchemaNode>();
  for (const path of paths) {
    const node = mergePath(root, path, 0);
    if (node) nodes.set(JSON.stringify(path), node);
  }
  // A scalar type only where the policy shows exactly one, and only on a node
  // the policy does not also read into.
  for (const [key, seen] of types) {
    const node = nodes.get(key);
    if (!node || seen.size !== 1) continue;
    const [type] = [...seen];
    const structured = node.properties || node.items || node.additionalProperties;
    if (!structured || type === 'object' || type === 'array') node.type = type;
  }
  return { $schema: 'http://json-schema.org/draft-07/schema#', ...root };
}

function pathToString(path: InputPath): string {
  let out = 'input';
  for (const seg of path) {
    out += seg === null ? '[]' : seg === ANY ? '[*]' : `.${seg}`;
  }
  return out;
}

export function registerRegoInferInputSchema(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'rego_infer_input_schema',
    {
      title: 'Infer input schema',
      description:
        'Statically analyse one or more Rego policies and return a JSON Schema (draft-07) object describing every input.* field the policies read. It follows the ways a policy reads input: loop variables (`some c in input.containers` then `c.image`), rules whose value is an input path (`pod_spec := input.request.object.spec`), function parameters (`trusted(c)`) and `object.get` keys. A key the policy computes is left open, and a scalar type is set only where a comparison with a literal, an `is_*` check or a string built-in shows it. Uses opa parse -- no running OPA server required. A starting point for test inputs and for a schema to give rego_check_schema; review it first, since types the policy never shows are left out. Accepts inline source, individual files, or directories (walked recursively for *.rego files).',
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

        const asts: unknown[] = [];
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
          if (ast) asts.push(ast);
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
              asts.push(ast);
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

        const shape = inputShape(asts);
        const schema = buildSchema(shape.paths, shape.types);
        const inputPaths = [...new Set(shape.paths.map(pathToString))].sort();

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
