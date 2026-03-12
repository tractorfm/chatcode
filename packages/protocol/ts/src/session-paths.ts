export const DEFAULT_SESSION_WORKDIR = "/home/vibe/workspace";

export function normalizeSessionWorkdir(input?: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed || trimmed === "." || trimmed === "/" || trimmed === "new") {
    return DEFAULT_SESSION_WORKDIR;
  }
  if (
    trimmed === "~" ||
    trimmed === "~/workspace" ||
    trimmed === DEFAULT_SESSION_WORKDIR
  ) {
    return DEFAULT_SESSION_WORKDIR;
  }

  let relative = trimmed;
  if (relative.startsWith("~/workspace/")) {
    relative = relative.slice("~/workspace/".length);
  } else if (relative.startsWith(`${DEFAULT_SESSION_WORKDIR}/`)) {
    relative = relative.slice(DEFAULT_SESSION_WORKDIR.length + 1);
  } else if (relative.startsWith("/")) {
    relative = relative.replace(/^\/+/, "");
  }

  relative = relative.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!relative) return DEFAULT_SESSION_WORKDIR;
  return `${DEFAULT_SESSION_WORKDIR}/${relative}`;
}

export function sessionFolderKey(path: string): string {
  if (!path || path === DEFAULT_SESSION_WORKDIR) return "";
  if (!path.startsWith(`${DEFAULT_SESSION_WORKDIR}/`)) return path;
  const relative = path.slice(DEFAULT_SESSION_WORKDIR.length + 1);
  return relative.split("/")[0] || "";
}

export function sessionSubpathWithinGroup(path: string, groupKey: string): string {
  if (!path.startsWith(DEFAULT_SESSION_WORKDIR)) return "";
  if (groupKey === "") return "";
  const groupRoot = `${DEFAULT_SESSION_WORKDIR}/${groupKey}`;
  if (path === groupRoot) return "";
  if (path.startsWith(`${groupRoot}/`)) return path.slice(groupRoot.length + 1);
  return "";
}

export function sessionTabPathSuffix(path: string): string {
  if (path === DEFAULT_SESSION_WORKDIR) return "";
  if (path.startsWith(`${DEFAULT_SESSION_WORKDIR}/`)) {
    return path.slice(DEFAULT_SESSION_WORKDIR.length + 1);
  }
  return "";
}

export function buildSessionTabTitle(title: string, workdir: string): string {
  const suffix = sessionTabPathSuffix(workdir);
  return suffix ? `${title} - ${suffix}` : title;
}
