import type { StoragePathRules } from "./types";

type PathSegment = string;

function normalizePathForRules(inputPath: string): string {
  const normalized = inputPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/+/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const stack: string[] = [];

  for (const part of parts) {
    if (part === ".") {
      continue;
    }

    if (part === "..") {
      stack.pop();
      continue;
    }

    stack.push(part);
  }

  return stack.join("/");
}

function normalizePattern(pattern: string): string {
  return normalizePathForRules(pattern);
}

function splitPathParts(path: string): PathSegment[] {
  const normalized = normalizePathForRules(path);
  return normalized.length > 0 ? normalized.split("/") : [];
}

function segmentMatchesPattern(pattern: string, segment: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return pattern === segment;
  }

  let expression = "^";
  for (const char of pattern) {
    switch (char) {
      case "*": {
        expression += "[^/]*";
        break;
      }
      case "?": {
        expression += "[^/]";
        break;
      }
      case ".":
      case "+":
      case "^":
      case "$":
      case "{":
      case "}":
      case "[":
      case "]":
      case "(":
      case ")":
      case "|":
      case "\\":
      case "/": {
        expression += `\\${char}`;
        break;
      }
      default:
        expression += char;
    }
  }
  expression += "$";

  const regex = new RegExp(expression);
  return regex.test(segment);
}

function matchesPattern(pattern: string, targetPath: string): boolean {
  const patternSegments = splitPathParts(pattern);
  const targetSegments = splitPathParts(targetPath);

  const matchSegmentRecursively = (patternIndex: number, targetIndex: number): boolean => {
    if (patternIndex === patternSegments.length) {
      return targetIndex === targetSegments.length;
    }

    const patternPart = patternSegments[patternIndex];
    if (patternPart === undefined) {
      return false;
    }
    if (patternPart === "**") {
      if (patternIndex === patternSegments.length - 1) {
        return true;
      }

      for (let nextTarget = targetIndex; nextTarget <= targetSegments.length; nextTarget++) {
        if (matchSegmentRecursively(patternIndex + 1, nextTarget)) {
          return true;
        }
      }
      return false;
    }

    if (targetIndex >= targetSegments.length) {
      return false;
    }

    const targetPart = targetSegments[targetIndex];
    if (targetPart === undefined) {
      return false;
    }

    if (!segmentMatchesPattern(patternPart, targetPart)) {
      return false;
    }

    return matchSegmentRecursively(patternIndex + 1, targetIndex + 1);
  };

  return matchSegmentRecursively(0, 0);
}

function hasRules(rules: string[] | undefined): rules is string[] {
  return Array.isArray(rules) && rules.length > 0;
}

export function matchesPathRules(targetPath: string, rules?: StoragePathRules | null): boolean {
  const include = hasRules(rules?.include)
    ? rules.include.map((pattern) => normalizePattern(pattern)).filter(Boolean)
    : [];
  const exclude = hasRules(rules?.exclude)
    ? rules.exclude.map((pattern) => normalizePattern(pattern)).filter(Boolean)
    : [];

  if (include.length > 0 && !include.some((pattern) => matchesPattern(pattern, targetPath))) {
    return false;
  }

  if (exclude.some((pattern) => matchesPattern(pattern, targetPath))) {
    return false;
  }

  return true;
}

export function filterPathsByRules(
  paths: ReadonlyArray<string>,
  rules?: StoragePathRules | null,
): string[] {
  return paths.filter((path) => matchesPathRules(path, rules));
}
