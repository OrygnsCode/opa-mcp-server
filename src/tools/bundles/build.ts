/**
 * `opa_bundle_build` -- build a deployable bundle from policy + data
 * paths via `opa build`.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../../config.js';
import { OpaCli } from '../../lib/opa-cli.js';
import { err, ok } from '../../lib/errors.js';
import { mapSubprocessFailure, validatePaths, withToolEnvelope } from '../../lib/tool-helpers.js';

const OpaBundleBuildInput = {
  paths: z
    .array(z.string())
    .min(1)
    .describe('Policy / data paths to include. Each must be in an allowed root.'),
  output: z
    .string()
    .min(1)
    .describe('Output bundle path (typically `*.tar.gz`). Must be in an allowed root.'),
  optimize: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .optional()
    .describe('Optimization level (0 = none, 2 = aggressive).'),
  revision: z.string().optional().describe('Bundle revision string written to the manifest.'),
  target: z
    .enum(['rego', 'wasm'])
    .optional()
    .describe('Build target (default `rego`; `wasm` compiles to WebAssembly).'),
  entrypoints: z
    .array(z.string())
    .optional()
    .describe('Entrypoint refs (required when `target=wasm` or `optimize > 0`).'),
  signingKey: z.string().optional().describe('Path to a signing key for inline signing.'),
  signingAlg: z.string().optional().describe('Signing algorithm (e.g. RS256).'),
  claimsFile: z.string().optional().describe('Path to a claims file for inline signing.'),
  capabilities: z.string().optional().describe('Path to a capabilities JSON file.'),
};

export interface OpaBundleBuildOutput {
  output: string;
  bytes: number;
}

export function registerOpaBundleBuild(server: McpServer, config: Config): void {
  const opa = new OpaCli(config);

  server.registerTool(
    'opa_bundle_build',
    {
      title: 'Build OPA bundle',
      description:
        'Build a deployable bundle from policy / data paths using `opa build`. Output is a `.tar.gz` archive with optional inline signing. Supports optimization, custom revision strings, and the WASM target.',
      inputSchema: OpaBundleBuildInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, { signal }) => {
      return withToolEnvelope<OpaBundleBuildOutput>(config, async () => {
        const inputPaths = [...input.paths, input.output];
        const validation = validatePaths(inputPaths, config);
        if (!validation.ok) return validation.error;

        const sourcePaths = validation.resolved.slice(0, input.paths.length);
        const outputPath = validation.resolved[input.paths.length]!;

        // Validate auxiliary files and capture their resolved (realpath) forms.
        let resolvedSigningKey: string | undefined;
        if (input.signingKey) {
          const v = validatePaths([input.signingKey], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedSigningKey = v.resolved[0];
        }

        let resolvedClaimsFile: string | undefined;
        if (input.claimsFile) {
          const v = validatePaths([input.claimsFile], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedClaimsFile = v.resolved[0];
        }

        let resolvedCapabilities: string | undefined;
        if (input.capabilities) {
          const v = validatePaths([input.capabilities], config, { mustExist: true });
          if (!v.ok) return v.error;
          resolvedCapabilities = v.resolved[0];
        }

        const result = await opa.build(
          {
            paths: sourcePaths,
            output: outputPath,
            optimize: input.optimize,
            revision: input.revision,
            target: input.target,
            entrypoints: input.entrypoints,
            signingKey: resolvedSigningKey,
            signingAlg: input.signingAlg,
            claimsFile: resolvedClaimsFile,
            capabilities: resolvedCapabilities,
          },
          signal,
        );

        const subprocessFailure = mapSubprocessFailure(result, 'opa');
        if (subprocessFailure) return subprocessFailure;

        if (result.exitCode !== 0) {
          return err('INVALID_REGO', 'opa build failed.', {
            details: { stderr: result.stderr.trim(), stdout: result.stdout.trim() },
          });
        }

        const { stat } = await import('node:fs/promises');
        const fileStat = await stat(outputPath);
        return ok<OpaBundleBuildOutput>({
          output: outputPath,
          bytes: fileStat.size,
        });
      });
    },
  );
}
