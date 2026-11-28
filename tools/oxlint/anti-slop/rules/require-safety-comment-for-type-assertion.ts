import { defineRule } from "@oxlint/plugins";

import {
  configuredSafetyMarkers,
  DEFAULT_SAFETY_MARKERS,
  isConstAssertion,
  markerPattern,
  safetyCommentsFor,
} from "../shared/safety-comments.ts";

import type { TypeAssertion } from "../shared/safety-comments.ts";

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `{{marker}}:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
    schema: [
      {
        type: "object",
        properties: {
          markers: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ markers: ["SAFETY"] }],
  },
  createOnce(context) {
    const patterns = new Map<string, RegExp>();

    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      const markers = configuredSafetyMarkers(context.options?.[0]);
      const patternKey = markers.join("\u0000");
      const pattern = patterns.get(patternKey) ?? markerPattern(markers);
      patterns.set(patternKey, pattern);
      if (safetyCommentsFor(context.sourceCode, node, pattern).length > 0) return;
      context.report({
        node,
        messageId: "missingSafetyComment",
        data: { marker: markers[0] ?? DEFAULT_SAFETY_MARKERS[0] },
      });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
