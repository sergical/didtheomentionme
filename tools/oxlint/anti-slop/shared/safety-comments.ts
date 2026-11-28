import type { Comment, ESTree, SourceCode } from "@oxlint/plugins";

export type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

export const DEFAULT_SAFETY_MARKERS = ["SAFETY"] as const;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

export function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

export function configuredSafetyMarkers(option: unknown): readonly string[] {
  if (typeof option !== "object" || option === null || !("markers" in option)) {
    return DEFAULT_SAFETY_MARKERS;
  }
  const configured = option.markers;
  if (!Array.isArray(configured)) return DEFAULT_SAFETY_MARKERS;
  const markers = configured.flatMap((marker) =>
    typeof marker === "string" && marker.trim().length > 0 ? [marker.trim()] : [],
  );
  return markers.length > 0 ? markers : DEFAULT_SAFETY_MARKERS;
}

export function markerPattern(markers: readonly string[]): RegExp {
  const alternation = markers
    .map((marker) => marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join("|");
  return new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:${alternation})\s*:\s*\S`,
    "u",
  );
}

function safetyCommentsBefore(
  sourceCode: SourceCode,
  owner: ESTree.Node,
  assertion: TypeAssertion,
  pattern: RegExp,
): Comment[] {
  return sourceCode
    .getCommentsBefore(owner)
    .filter((comment) => comment.end <= assertion.start && pattern.test(comment.value));
}

/** The marker comments that justify one type assertion, or none when it has no justification. */
export function safetyCommentsFor(
  sourceCode: SourceCode,
  node: TypeAssertion,
  pattern: RegExp,
): Comment[] {
  let current: ESTree.Node = node;
  while (true) {
    const comments = safetyCommentsBefore(sourceCode, current, node, pattern);
    if (comments.length > 0) return comments;
    if (commentOwnerKinds.has(current.type)) {
      const exportDeclaration = current.parent;
      return exportDeclaration.type === "ExportNamedDeclaration" &&
        exportDeclaration.declaration === current
        ? safetyCommentsBefore(sourceCode, exportDeclaration, node, pattern)
        : [];
    }
    if (current.parent.type === "Program") return [];
    current = current.parent;
  }
}
