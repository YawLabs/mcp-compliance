import {
  summarizeIssues,
  validatePromptSchemas,
  validateResourceSchemas,
  validateToolAnnotations,
  validateToolOutputSchemas,
  validateToolSchemas,
  validateToolTitles,
} from "../../checks/validators.js";
import { hasPrompts, hasResources, hasTools, type ModernSuiteContext } from "./context.js";

/**
 * Definition-shape tests of the 2026-07-28 suite (the six list-based
 * schema checks; the post-hoc wire checks live in posthoc.ts). They read
 * the lists the features module cached and never re-fetch: a null list
 * (the capability's `-list` test did not run under `--only`, or failed)
 * is reported as skipped, not as a defect of the definitions.
 */

interface Outcome {
  passed: boolean;
  details: string;
}

const pass = (details: string): Outcome => ({ passed: true, details });
const fail = (details: string): Outcome => ({ passed: false, details });

function skipped(what: string): Outcome {
  return pass(`skipped: no ${what} list available (the ${what}-list test did not run or failed)`);
}

function showNames(names: string[], max = 5): string {
  return `${names.slice(0, max).join(", ")}${names.length > max ? "..." : ""}`;
}

export async function runSchema(ctx: ModernSuiteContext): Promise<void> {
  const { harness, state } = ctx;

  if (hasTools(ctx)) {
    await harness.check("tools-schema", async () => {
      const tools = state.tools;
      if (!tools) return skipped("tools");
      if (tools.length === 0) return pass("No tools to validate");
      const v = validateToolSchemas(tools);
      harness.warnings.push(...v.warnings);
      if (v.issues.length > 0) return fail(summarizeIssues(v.issues));
      return pass(`All ${tools.length} tool(s) have valid schemas`);
    });

    await harness.check("tools-annotations", async () => {
      const tools = state.tools;
      if (!tools) return skipped("tools");
      if (tools.length === 0) return pass("No tools to validate");
      const v = validateToolAnnotations(tools);
      if (v.issues.length > 0) return fail(summarizeIssues(v.issues));
      return pass(
        v.annotated > 0 ? `${v.annotated} tool(s) with valid annotations` : "No tools have annotations (optional)",
      );
    });

    await harness.check("tools-title-field", async () => {
      const tools = state.tools;
      if (!tools) return skipped("tools");
      if (tools.length === 0) return pass("No tools to validate");
      const v = validateToolTitles(tools);
      if (v.issues.length > 0) return fail(summarizeIssues(v.issues));
      if (v.withTitle.length === 0) return pass("No tools have title field (optional)");
      if (v.withoutTitle.length > 0) {
        return pass(
          `${v.withTitle.length}/${tools.length} tool(s) have title field; missing: ${showNames(v.withoutTitle)}`,
        );
      }
      return pass(`${v.withTitle.length}/${tools.length} tool(s) have title field`);
    });

    await harness.check("tools-output-schema", async () => {
      const tools = state.tools;
      if (!tools) return skipped("tools");
      if (tools.length === 0) return pass("No tools to validate");
      const v = validateToolOutputSchemas(tools);
      if (v.issues.length > 0) return fail(summarizeIssues(v.issues));
      return pass(
        v.withSchema > 0 ? `${v.withSchema} tool(s) with valid outputSchema` : "No tools have outputSchema (optional)",
      );
    });
  }

  if (hasPrompts(ctx)) {
    await harness.check("prompts-schema", async () => {
      const prompts = state.prompts;
      if (!prompts) return skipped("prompts");
      if (prompts.length === 0) return pass("No prompts to validate");
      const v = validatePromptSchemas(prompts);
      harness.warnings.push(...v.warnings);
      if (v.issues.length > 0) return fail(summarizeIssues(v.issues));
      return pass(`All ${prompts.length} prompt(s) valid`);
    });
  }

  if (hasResources(ctx)) {
    await harness.check("resources-schema", async () => {
      const resources = state.resources;
      if (!resources) return skipped("resources");
      if (resources.length === 0) return pass("No resources to validate");
      const v = validateResourceSchemas(resources);
      harness.warnings.push(...v.warnings);
      if (v.issues.length > 0) return fail(summarizeIssues(v.issues));
      return pass(`All ${resources.length} resource(s) valid`);
    });
  }
}
