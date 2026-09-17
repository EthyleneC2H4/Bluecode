/** Lexical normalization only. Realpath/nearest-existing-parent belongs to adapters. */
export function normalizePath(path: string): string {
  const absolute = path
  const parts: string[] = []
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") { parts.pop(); continue }
    parts.push(part)
  }
  return "/" + parts.join("/")
}
export function within(path: string, root: string): boolean {
  const p = normalizePath(path), r = normalizePath(root)
  return r === "/" || p === r || p.startsWith(r + "/")
}
export function sensitivePath(path: string): boolean {
  const p = normalizePath(path)
  if (/\.(?:pub)$|\/\.env\.(?:example|sample|template|dist)$/i.test(p)) return false
  return /\/(?:\.env(?:\.[^/]+)?|\.npmrc|\.netrc|\.git-credentials|credentials\.json|[^/]+\.(?:key|p12|pfx))$/i.test(p)
    || /\/\.ssh\/(?:id_[^/.]+|config)$|\/\.aws\/credentials$|\/etc\/(?:shadow|passwd|sudoers)$|\/proc\/(?:self|\d+)\/environ$/.test(p)
}
