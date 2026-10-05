/**
 * MCP Prompts -- slash-command-like workflow templates.
 *
 * Each prompt is a stateless instruction set the agent receives when
 * the user invokes it. They orient the agent toward a specific
 * workflow (write a policy, review one, debug a decision) and tell it
 * which of our tools to call in what order.
 */
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from '../config.js';

const policyAuthoringAssistantPrompt = (args: {
  description?: string;
  package_name?: string;
}): string => {
  const description = args.description ?? '<not provided>';
  const packageName = args.package_name ?? '<choose a package, e.g. authz>';
  return `You are writing an Open Policy Agent (OPA) Rego policy.

Goal: a policy that allows what it should and denies everything else,
including input its author did not expect.

User's description:
${description}

Suggested package: ${packageName}

Workflow:
1. Pin down the input and the decision.
   - What does \`input\` look like? Ask the user, or find an example.
   - Where will it run? OPA 1.x and conftest take Rego v1; a Gatekeeper
     ConstraintTemplate \`rego:\` field is Rego v0.
   - Is the decision a boolean (\`allow\`) or a set (\`deny\`)?
2. For every field a rule reads, decide what a missing, null or
   wrong-typed value must do, and write the rule so that happens: start
   from \`default allow := false\`, require the safe value (\`== true\`, an
   allow-list) rather than testing for the bad one, and negate only rules
   or functions of bound values, never an expression on a raw input field.
3. \`rego_format\`, then \`rego_check\` with \`strict: true\` until it is
   clean. For errors you do not recognise, \`rego_suggest_fix\` with the
   diagnostics.
4. \`rego_lint\`; fix the error and warning findings.
5. Probe: one \`rego_eval\` call with an \`inputs\` batch: each field the
   policy reads absent, null and of the wrong type, the other places the
   same data can live, \`{}\`, one good input and one bad one. Anything
   that should be denied and is not is a fail-open: fix it, probe again.
6. Keep the probes as tests: a must-deny table and a must-allow table.
   \`rego_generate_test_skeleton\` gives a starting point whose stubs stay
   skipped until filled in. Run \`rego_test\` until \`allPassed\` is true.
7. Return the policy and the tests, and say which probes you ran.`;
};

const policyReviewChecklistPrompt = (args: { source?: string }): string => {
  // Collapse any run of 3+ backticks to 2 so user-supplied source cannot
  // close the enclosing ```rego fence and inject arbitrary prompt content.
  const safeSource = (args.source ?? '<paste the policy via the next user message>').replace(
    /`{3,}/g,
    '``',
  );
  return `You are reviewing the following Rego policy:

\`\`\`rego
${safeSource}
\`\`\`

Apply this checklist, calling tools as needed:

1. **Compiles.** \`rego_check\` with \`strict: true\`.
2. **Lints.** \`rego_lint\`. Address error and warning findings.
3. **Defaults.** The main decision has \`default allow := false\` or is a
   deny set, and there is no \`default allow := true\`.
4. **Fail-open probe, the decisive step.** One \`rego_eval\` call with an
   \`inputs\` batch: every field the policy reads absent, null and of the
   wrong type (\`"true"\`, \`"false"\`, \`0\`, a string where a list
   belongs, \`[]\`, \`{}\`), case variants, the other places the same data
   can live (init containers, controller templates, module resources), and
   \`{}\` as the whole input. Report every input that is allowed but
   should be denied, with the input itself.
5. **Negation.** A \`not\` applied to an expression on a raw input field,
   such as \`not startswith(input.image, "registry/")\`, is true when the
   field is a number or null, so the rule matches input it never checked.
   Flag it and rewrite it to negate a helper rule over a bound value.
6. **Tests.** Tests exist, include must-deny cases for the probes above
   and not only the happy path, and \`rego_test\` reports
   \`allPassed: true\`.
7. **http.send.** If present: is it needed, does it set a timeout, and
   what does the decision do when the call fails?

Return a concise review: pass or fail per item, each fail-open with the
input that gets through, and recommended diffs.`;
};

const decisionDebuggingWorkflowPrompt = (args: {
  query?: string;
  expectation?: string;
}): string => {
  return `You are debugging an unexpected Rego decision.

Query: ${args.query ?? '<not provided -- ask the user>'}
User's expectation: ${args.expectation ?? '<ask the user what they expected>'}

Workflow:
1. Gather inputs.
   - The exact input document the agent saw at decision time.
   - The policy and any data files involved.
   - The actual returned decision (vs. the expected one).
2. Reproduce the decision with \`rego_eval\` (no flags). Confirm it
   matches the reported outcome.
3. Re-run with \`rego_explain_decision\` for the trace. Its \`Fail\`
   lines name the condition that stopped each rule, with the values
   involved. For an \`allow\` that is false or undefined, or a deny set
   that is empty, \`rego_explain_undefined\` names the blocking condition
   of every rule definition.
4. The cause is one of:
   a. **Input mismatch** -- the policy expected a different input shape.
      Use \`rego_infer_input_schema\` to list the refs the policy reads
      and confirm each is present in the input.
   b. **Rule logic** -- a guard fired or didn't fire when it should
      have. Read the trace and explain which rule's body evaluated to
      true/false and why.
   c. **Default decision** -- no rule produced a value, so the default
      kicked in.
5. Propose the smallest fix: either an input correction or a policy
   change. If a policy change, run \`rego_check\` and \`rego_test\` on the
   patched policy before declaring it fixed.

Be specific in the explanation: cite rule names, line numbers, and the
exact input value that flipped each guard.`;
};

export function registerPrompts(server: McpServer, _config: Config): void {
  server.registerPrompt(
    'policy_authoring_assistant',
    {
      title: 'Policy authoring assistant',
      description:
        'Guides an agent through writing a new Rego policy: clarify decision shape, draft, format, check, lint, test, iterate.',
      argsSchema: {
        description: z.string().optional().describe('What the policy needs to enforce.'),
        package_name: z.string().optional().describe('Suggested package path (e.g. "authz").'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: policyAuthoringAssistantPrompt(args) },
        },
      ],
    }),
  );

  server.registerPrompt(
    'policy_review_checklist',
    {
      title: 'Policy review checklist',
      description:
        'Review checklist for an existing Rego policy: compile, lint, tests, default-deny, http.send, annotations, input shape.',
      argsSchema: {
        source: z
          .string()
          .optional()
          .describe('Rego source to review. Optional -- agent can ask for it.'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: policyReviewChecklistPrompt(args) },
        },
      ],
    }),
  );

  server.registerPrompt(
    'decision_debugging_workflow',
    {
      title: 'Decision debugging workflow',
      description:
        'Diagnostic flow for an unexpected Rego decision: reproduce, explain trace, identify input vs logic vs default cause, propose minimal fix.',
      argsSchema: {
        query: z
          .string()
          .optional()
          .describe('The Rego query that produced the unexpected result.'),
        expectation: z.string().optional().describe('What the user expected to happen.'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: decisionDebuggingWorkflowPrompt(args) },
        },
      ],
    }),
  );
}
