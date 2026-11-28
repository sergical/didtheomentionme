import { defineRule } from "@oxlint/plugins";

import {
  configuredSafetyMarkers,
  isConstAssertion,
  markerPattern,
  safetyCommentsFor,
} from "../shared/safety-comments.ts";

import type { Comment, ESTree, SourceCode } from "@oxlint/plugins";

import type { TypeAssertion } from "../shared/safety-comments.ts";

const DEFAULT_ALLOWED_PATTERNS = [String.raw`https?://\S`] as const;

const directivePatterns: readonly RegExp[] = [
  /^(?:eslint|oxlint)-(?:disable|enable|env)\b/u,
  /^eslint\s+["']?[\w@/-]+["']?\s*:/u,
  /^@ts-(?:expect-error|ignore|check|nocheck)\b/u,
  /^(?:prettier-ignore(?:-start|-end)?|oxfmt-ignore|dprint-ignore(?:-file)?|@vite-ignore)$/u,
  /^biome-ignore(?:-all|-start|-end)?\s+(?:lint|format|assist|syntax)\b/u,
  /^deno-(?:lint|fmt)-ignore(?:-file)?(?:\s+[\w-]+)*(?:\s+--\s.*)?$/u,
  /^(?:v8|c8|istanbul) ignore (?:next|start|stop|file|if|else)\b/u,
  /^node:coverage (?:disable|enable|ignore next)\b/u,
  /^@(?:vitest|jest)-environment\b/u,
  /^@jsx(?:ImportSource|Runtime|Frag)?\b/u,
  /^[#@]__[A-Z_]+__$/u,
  /^(?:webpack|turbopack)[A-Z]\w*\s*:/u,
  /^[#@]\s*sourceMappingURL=/u,
];

const blockOnlyDirectivePatterns: readonly RegExp[] = [
  /^globals?\s+[\w$]+(?:\s*:\s*\w+)?(?:\s*,\s*[\w$]+(?:\s*:\s*\w+)?)*$/u,
  /^exported\s+[\w$]+(?:\s*,\s*[\w$]+)*$/u,
];

const tripleSlashDirective = /^\/\s*<(?:reference|amd-module|amd-dependency)\b/u;

const licencePattern =
  /\bcopyright\b|©|SPDX-License-Identifier:|@licen[cs]e\b|\blicen[cs]ed under\b|\b(?:MIT|ISC|Apache|BSD|Mozilla Public|General Public|MPL|[AL]?GPL)\b[^\n]*\blicen[cs]e\b/iu;

const nextLinePattern = /^\r?\n[ \t]*$/u;

const exportKinds = new Set([
  "ExportAllDeclaration",
  "ExportDefaultDeclaration",
  "ExportNamedDeclaration",
  "TSExportAssignment",
]);

const memberKinds = new Set([
  "AccessorProperty",
  "MethodDefinition",
  "Property",
  "PropertyDefinition",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSEnumMember",
  "TSIndexSignature",
  "TSMethodSignature",
  "TSPropertySignature",
]);

const scopeBoundaryKinds = new Set([
  "BlockStatement",
  "CallExpression",
  "NewExpression",
  "StaticBlock",
]);

function configuredAllowedPatterns(option: unknown): readonly string[] {
  if (typeof option !== "object" || option === null || !("allow" in option)) {
    return DEFAULT_ALLOWED_PATTERNS;
  }
  const configured = option.allow;
  if (!Array.isArray(configured)) return DEFAULT_ALLOWED_PATTERNS;
  return configured.flatMap((source) =>
    typeof source === "string" && source.length > 0 ? [source] : [],
  );
}

function isDirective(comment: Comment): boolean {
  if (comment.type === "Line" && tripleSlashDirective.test(comment.value)) return true;
  const text = comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*[*!]+\s?/u, ""))
    .join("\n")
    .trim();
  if (directivePatterns.some((pattern) => pattern.test(text))) return true;
  return (
    comment.type === "Block" && blockOnlyDirectivePatterns.some((pattern) => pattern.test(text))
  );
}

function licenceHeader(sourceText: string, comments: readonly Comment[]): readonly Comment[] {
  const first = comments.findIndex((comment) => comment.type !== "Shebang");
  const head = comments[first];
  if (head === undefined) return [];
  const start = first === 0 ? 0 : (comments[first - 1]?.end ?? 0);
  if (sourceText.slice(start, head.start).trim().length > 0) return [];
  const header = [head];
  if (head.type === "Line") {
    for (const comment of comments.slice(first + 1)) {
      const previous = header.at(-1);
      if (previous === undefined || comment.type !== "Line") break;
      if (!nextLinePattern.test(sourceText.slice(previous.end, comment.start))) break;
      header.push(comment);
    }
  }
  return header.some((comment) => licencePattern.test(comment.value)) ? header : [];
}

function exportedLocalNames(program: ESTree.Program): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.source === null) {
      for (const specifier of statement.specifiers) {
        names.add("name" in specifier.local ? specifier.local.name : specifier.local.value);
      }
    }
    if (
      statement.type === "ExportDefaultDeclaration" &&
      statement.declaration.type === "Identifier"
    ) {
      names.add(statement.declaration.name);
    }
  }
  return names;
}

function declaredNames(node: ESTree.Node): readonly string[] {
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((declarator) =>
      declarator.id.type === "Identifier" ? [declarator.id.name] : [],
    );
  }
  if (!("id" in node) || typeof node.id !== "object" || node.id === null) return [];
  return "name" in node.id && typeof node.id.name === "string" ? [node.id.name] : [];
}

function isExported(node: ESTree.Node, exportedNames: ReadonlySet<string>): boolean {
  if (exportKinds.has(node.type)) return true;
  return (
    node.parent?.type === "Program" &&
    declaredNames(node).some((name) => exportedNames.has(name))
  );
}

function isObjectFreezeCall(node: ESTree.Node): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Object" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "freeze"
  );
}

function belongsToExportedDeclaration(
  node: ESTree.Node,
  exportedNames: ReadonlySet<string>,
): boolean {
  let child = node;
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (scopeBoundaryKinds.has(current.type) && !isObjectFreezeCall(current)) return false;
    if ("body" in current && current.body === child && current.type.includes("Function")) {
      return false;
    }
    if (isExported(current, exportedNames)) return true;
    child = current;
    current = current.parent;
  }
  return false;
}

function documentsExportedApi(
  sourceCode: SourceCode,
  comment: Comment,
  exportedNames: ReadonlySet<string>,
): boolean {
  if (comment.type !== "Block" || !comment.value.startsWith("*")) return false;
  const token = sourceCode.getTokenAfter(comment);
  if (token === null) return false;
  let node = sourceCode.getNodeByRangeIndex(token.start);
  if (node === null || node.type === "Program") return false;
  while (
    node.parent !== null &&
    node.parent.type !== "Program" &&
    node.parent.start === token.start
  ) {
    node = node.parent;
  }
  if (node.start !== token.start) return false;
  if (isExported(node, exportedNames)) return true;
  return memberKinds.has(node.type) && belongsToExportedDeclaration(node, exportedNames);
}

function removalRange(sourceText: string, comment: Comment): [number, number] {
  const lineStart = sourceText.lastIndexOf("\n", comment.start - 1) + 1;
  const newline = sourceText.indexOf("\n", comment.end);
  const lineEnd = newline === -1 ? sourceText.length : newline;
  const before = sourceText.slice(lineStart, comment.start);
  const after = sourceText.slice(comment.end, lineEnd);
  if (after.trim().length > 0) return [comment.start, comment.end];
  if (before.trim().length === 0) {
    return [lineStart, Math.min(lineEnd + 1, sourceText.length)];
  }
  return [lineStart + before.trimEnd().length, lineEnd];
}

/** Reject comments, which nothing checks, except directives, exported API docs, a licence header and allowed patterns. */
export const noCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    hasSuggestions: true,
    docs: {
      description:
        "Reject comments except tool directives, doc comments on exported API, a leading licence header, attached safety markers and configured patterns.",
    },
    messages: {
      comment:
        "Nothing checks a comment, so it goes stale and gives the next change an excuse. Delete it. If it says what the code does, rename or extract until the code says it. If it records a constraint, encode the constraint as a type, a test or a lint rule. If it explains a workaround, fix the cause. A note about behaviour forced by something outside this code must match an allowed pattern, by default a link to what forces it.",
      unattachedMarker:
        "This `{{marker}}:` comment does not sit before a type assertion, so it justifies nothing. Delete it, or move it to the assertion it is about.",
      deleteComment: "Delete this comment.",
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
          allow: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ markers: ["SAFETY"], allow: [...DEFAULT_ALLOWED_PATTERNS] }],
  },
  createOnce(context) {
    const justifying = new Set<number>();
    const markerPatterns = new Map<string, RegExp>();
    const allowedPatterns = new Map<string, readonly RegExp[]>();

    const safetyPattern = (): RegExp => {
      const markers = configuredSafetyMarkers(context.options?.[0]);
      const key = markers.join("\u0000");
      const pattern = markerPatterns.get(key) ?? markerPattern(markers);
      markerPatterns.set(key, pattern);
      return pattern;
    };

    const allowed = (): readonly RegExp[] => {
      const sources = configuredAllowedPatterns(context.options?.[0]);
      const key = sources.join("\u0000");
      const patterns = allowedPatterns.get(key) ?? sources.map((source) => new RegExp(source, "u"));
      allowedPatterns.set(key, patterns);
      return patterns;
    };

    const recordJustification = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      for (const comment of safetyCommentsFor(context.sourceCode, node, safetyPattern())) {
        justifying.add(comment.start);
      }
    };

    return {
      before() {
        justifying.clear();
      },
      TSAsExpression: recordJustification,
      TSTypeAssertion: recordJustification,
      "Program:exit"(program) {
        const sourceCode = context.sourceCode;
        const comments = sourceCode.getAllComments();
        const exportedNames = exportedLocalNames(program);
        const marker = safetyPattern();
        const allowedByOption = allowed();

        const header = new Set(licenceHeader(sourceCode.text, comments));

        for (const comment of comments) {
          if (comment.type === "Shebang") continue;
          if (isDirective(comment)) continue;
          const hasMarker = marker.test(comment.value);
          if (hasMarker && justifying.has(comment.start)) continue;
          if (!hasMarker) {
            if (header.has(comment)) continue;
            if (allowedByOption.some((pattern) => pattern.test(comment.value))) continue;
            if (documentsExportedApi(sourceCode, comment, exportedNames)) continue;
          }
          context.report({
            loc: comment.loc,
            messageId: hasMarker ? "unattachedMarker" : "comment",
            data: { marker: configuredSafetyMarkers(context.options?.[0])[0] ?? "SAFETY" },
            suggest: [
              {
                messageId: "deleteComment",
                fix: (fixer) => fixer.removeRange(removalRange(sourceCode.text, comment)),
              },
            ],
          });
        }
      },
    };
  },
});
