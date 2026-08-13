const privateSignalPath = (path: string): boolean =>
  path === "/api/annotations"
  || path === "/api/memories"
  || path.startsWith("/api/memory-candidates/")
  || path.startsWith("/api/memory/")
  || path === "/api/watches"
  || /^\/api\/watches\/[^/]+\/resolve$/.test(path)
  || path.startsWith("/api/admin/");

export function signalEndpoint(path: string, apiBase: string, privateApiBase: string): string {
  const pathname = path.split("?", 1)[0] ?? path;
  return `${privateSignalPath(pathname) ? privateApiBase : apiBase}${path}`;
}
