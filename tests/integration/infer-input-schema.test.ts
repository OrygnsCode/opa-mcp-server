/**
 * rego_infer_input_schema on real `opa parse` output.
 *
 * A policy rarely spells out a full `input.` path where it reads a field. It
 * binds a loop variable, a rule or a function parameter to part of the input
 * and reads through that. Each case here reads input one of those ways.
 */
import { describe, expect, it } from 'vitest';

import { registerRegoInferInputSchema } from '../../src/tools/helpers/infer-input-schema.js';
import type { RegoInferInputSchemaOutput } from '../../src/tools/helpers/infer-input-schema.js';
import { baseConfig, callTool, makeServer } from '../unit/tools/_helpers.js';

const config = { ...baseConfig, opaBinary: process.env['OPA_BINARY'] ?? 'opa' };

async function infer(source: string): Promise<RegoInferInputSchemaOutput> {
  const server = makeServer();
  registerRegoInferInputSchema(server, config);
  const env = await callTool<RegoInferInputSchemaOutput>(server, 'rego_infer_input_schema', {
    source,
  });
  expect(env.ok, JSON.stringify(env.error)).toBe(true);
  return env.data!;
}

/** The schema node at a dotted path; `[]` steps into array items. */
function node(schema: object, path: string): Record<string, unknown> | undefined {
  let cur = schema as Record<string, unknown> | undefined;
  for (const part of path.split('.')) {
    if (cur === undefined) return undefined;
    if (part === '[]') cur = cur['items'] as Record<string, unknown> | undefined;
    else cur = (cur['properties'] as Record<string, Record<string, unknown>> | undefined)?.[part];
  }
  return cur;
}

describe('rego_infer_input_schema on real ASTs', () => {
  it('follows a rule whose value is an input path, and a loop over it', async () => {
    const out = await infer(`package k8s

pod_spec := input.request.object.spec if input.request.kind.kind == "Pod"

pod_spec := input.request.object.spec.template.spec if input.request.kind.kind == "Deployment"

deny contains msg if {
	some c in pod_spec.containers
	startswith(c.image, "docker.io/")
	msg := $"container {c.name} pulls from Docker Hub"
}
`);
    expect(out.inputPaths).toEqual(
      expect.arrayContaining([
        'input.request.kind.kind',
        'input.request.object.spec.containers[].image',
        'input.request.object.spec.containers[].name',
        'input.request.object.spec.template.spec.containers[].image',
        'input.request.object.spec.template.spec.containers[].name',
      ]),
    );
    expect(node(out.schema, 'request.kind.kind')).toEqual({ type: 'string' });
    const containers = node(out.schema, 'request.object.spec.containers');
    expect(containers?.['type']).toBe('array');
    expect(node(out.schema, 'request.object.spec.containers.[].image')).toEqual({
      type: 'string',
    });
  });

  it('follows function parameters, object.get keys and a function called in a rule head', async () => {
    const out = await infer(`package k8s

containers contains c if {
	some field in ["containers", "initContainers"]
	some c in object.get(input.spec, field, [])
}

name(c) := object.get(c, "name", "unnamed")

privileged(c) if object.get(c, ["securityContext", "privileged"], false) == true

deny contains $"{name(c)} is privileged" if {
	some c in containers
	privileged(c)
}
`);
    expect(out.inputPaths).toEqual(
      expect.arrayContaining([
        'input.spec.containers[].name',
        'input.spec.containers[].securityContext.privileged',
        'input.spec.initContainers[].name',
        'input.spec.initContainers[].securityContext.privileged',
      ]),
    );
    expect(node(out.schema, 'spec.initContainers.[].securityContext.privileged')).toEqual({
      type: 'boolean',
    });
  });

  it('leaves a computed key open and follows every and comprehensions', async () => {
    const out = await infer(`package misc

deny contains k if {
	some k, v in input.metadata.labels
	v == ""
}

low_ports if {
	every port in input.ports {
		port.number < 1024
	}
}

admins := {u | some u in input.users; u.role == "admin"}

allow if data.misc.admins[_].name == input.user
`);
    expect(out.inputPaths).toEqual(
      expect.arrayContaining([
        'input.metadata.labels[*]',
        'input.ports[].number',
        'input.users[].role',
        'input.users[].name',
        'input.user',
      ]),
    );
    const labels = node(out.schema, 'metadata.labels');
    expect(labels?.['additionalProperties']).toEqual({ type: 'string' });
    expect(node(out.schema, 'ports.[].number')).toEqual({ type: 'number' });
  });

  it('sets no type the policy does not show', async () => {
    const out = await infer(`package p

allow if input.flag
`);
    expect(out.inputPaths).toEqual(['input.flag']);
    expect(node(out.schema, 'flag')).toEqual({});
  });
});
