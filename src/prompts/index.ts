/**
 * MCP Prompts — slash-command-like workflow templates.
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
  return `You are a Rego policy authoring assistant.

Goal: produce a working policy for the user's described scenario.

User's description:
${description}

Suggested package: ${packageName}

Workflow:
1. Clarify the inputs and decision the policy needs to produce.
   - What does \`input\` look like? (Ask the user if unclear.)
   - What is the boolean or set-valued decision? (allow / deny / reasons)
2. Draft the policy using \`rego.v1\` syntax. Keep it minimal.
3. Call \`rego_format\` to canonicalise it.
4. Call \`rego_check\` on the formatted source. If it returns errors,
   call \`rego_suggest_fix\` with the diagnostics and incorporate the
   suggestions.
5. Call \`rego_lint\` and address \`error\` and \`warning\` level findings.
6. Call \`rego_generate_test_skeleton\` and turn the stubs into real
   tests with realistic inputs.
7. Run \`rego_test\` and iterate until tests pass.
8. Return the final policy + tests to the user.`;
};

const policyReviewChecklistPrompt = (args: { source?: string }): string => {
  return `You are reviewing the following Rego policy:

\`\`\`rego
${args.source ?? '<paste the policy via the next user message>'}
\`\`\`

Apply this checklist, calling tools as needed:

1. **Compiles cleanly.** Run \`rego_check\` with \`strict: true\`.
2. **Lints cleanly.** Run \`rego_lint\`. Address every \`error\` and
   \`warning\` finding. Note \`notice\` items but don't insist.
3. **Has tests.** If no \`*_test.rego\` was provided, call
   \`rego_generate_test_skeleton\` and propose tests.
4. **Default-deny.** Confirm the principal decision (e.g. \`allow\`) has
   a \`default := false\` (or equivalent). If not, flag it.
5. **No HTTP_SEND.** Search the source for \`http.send\`. If present,
   confirm it's truly necessary; it's a major performance and security
   concern in a policy hot path.
6. **Annotations.** Check that exported rules have docstrings. If
   missing, suggest minimal \`# METADATA\` annotations.
7. **Shape of input.** Use \`rego_describe_policy\` to enumerate input
   refs the policy reads; confirm the documented input contract
   matches.

Return a concise review with: pass/fail per item, recommended diffs.`;
};

const decisionDebuggingWorkflowPrompt = (args: {
  query?: string;
  expectation?: string;
}): string => {
  return `You are debugging an unexpected Rego decision.

Query: ${args.query ?? '<not provided — ask the user>'}
User's expectation: ${args.expectation ?? '<ask the user what they expected>'}

Workflow:
1. Gather inputs.
   - The exact input document the agent saw at decision time.
   - The policy and any data files involved.
   - The actual returned decision (vs. the expected one).
2. Reproduce the decision with \`rego_eval\` (no flags). Confirm it
   matches the reported outcome.
3. Re-run with \`rego_explain_decision\` to get a structured trace.
   Identify which rules were evaluated and which fired.
4. The cause is one of:
   a. **Input mismatch** — the policy expected a different input shape.
      Use \`rego_describe_policy\` to list the refs the policy reads
      and confirm each is present in the input.
   b. **Rule logic** — a guard fired or didn't fire when it should
      have. Read the trace and explain which rule's body evaluated to
      true/false and why.
   c. **Default decision** — no rule produced a value, so the default
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
          .describe('Rego source to review. Optional — agent can ask for it.'),
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
