import { Parser, Language, type Node } from "web-tree-sitter"
import { hit, type Hit, type Scan } from "./model"
import { normalizePath, sensitivePath } from "./paths"

let languagePromise: Promise<Language> | undefined
/** Sole asset-loading boundary: pinned local WASM, never source files or URLs. */
async function language(): Promise<Language> {
  return languagePromise ??= (async () => {
    await Parser.init({ locateFile: () => import.meta.resolve("web-tree-sitter/tree-sitter.wasm").replace(/^file:\/\//, "") })
    const asset = import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm")
    return Language.load(decodeURIComponent(asset.replace(/^file:\/\//, "")))
  })()
}
function literal(node: Node): string | undefined {
  if (node.type === "raw_string") return node.text.slice(1, -1)
  if (node.type === "word" || node.type === "number") return node.text.replace(/\\(.)/g, "$1")
  if (node.type === "string" && node.namedChildren.every(c => c?.type === "string_content")) return node.text.slice(1, -1).replace(/\\(["\\$`])/g, "$1")
  if (node.type === "command_name" && node.namedChildren[0]) return literal(node.namedChildren[0])
  if (node.type === "concatenation") {
    const parts = node.namedChildren.filter((c): c is Node => c !== null).map(literal)
    if (parts.every(p => p !== undefined)) return parts.join("")
  }
  return undefined
}
const base = (s: string) => s.split("/").at(-1) ?? s
function unwrap(words: string[]): string[] {
  let index = 0
  for (let depth = 0; depth < 8; depth++) {
    const wrapper = base(words[index] ?? "")
    if (!/^(?:sudo|env|command|builtin|nohup|nice|timeout)$/.test(wrapper)) break
    index++
    while (index < words.length) {
      const word = words[index]!
      if (wrapper === "env" && /^[A-Za-z_]\w*=/.test(word)) { index++; continue }
      if (word === "--") { index++; break }
      if (!word.startsWith("-")) break
      const takes = (wrapper === "sudo" && /^-(?:u|g|h|p|C|T)$|^--(?:user|group|host|prompt|chdir)$/.test(word))
        || (wrapper === "env" && /^-(?:u|C)$|^--(?:unset|chdir)$/.test(word))
        || (wrapper === "nice" && word === "-n") || (wrapper === "timeout" && /^(?:-s|-k|--signal|--kill-after)$/.test(word))
      index += takes ? 2 : 1
    }
    if (wrapper === "timeout" && words[index]) index++
  }
  return words.slice(index)
}
export async function scanBash(text: string, root: string, depth = 0): Promise<Scan> {
  const grammar = await language()
  const parser = new Parser()
  parser.setLanguage(grammar)
  const tree = parser.parse(text)
  if (!tree) { parser.delete(); return { hits: [], partial: true } }
  const hits: Hit[] = []
  let partial = tree.rootNode.hasError
  const add = (node: Node, suffix: string, severity: Hit["severity"] = "critical") => hits.push(hit("dangerous-command", suffix, node.startIndex, node.endIndex, node.text, severity))
  const commands = (node: Node): string[] => {
    const name = node.childForFieldName("name")
    const args = node.childrenForFieldName("argument")
    return [name, ...args].filter((n): n is Node => n !== null).map(n => literal(n) ?? n.text)
  }
  try {
    const nodes = [tree.rootNode]
    while (nodes.length) {
      const node = nodes.pop()!
      if (/^(?:expansion|simple_expansion|command_substitution|process_substitution|arithmetic_expansion|heredoc_body|function_definition|for_statement|while_statement|case_statement)$/.test(node.type)) partial = true
      if (node.type === "command") {
        const nameNode = node.childForFieldName("name")
        if (nameNode && literal(nameNode) === undefined) partial = true
        const words = unwrap(commands(node)), command = base(words[0] ?? ""), args = words.slice(1)
        if (command === "rm") {
          const recursive = args.some(s => /^-[^-]*[rR]/.test(s) || s === "--recursive")
          const targets = args.filter(s => !s.startsWith("-"))
          if (recursive && targets.some(s => /^(?:\/(?:\*|\*\*)?|~(?:\/\*)?|["']?\$\{?HOME\}?["']?(?:\/\*)?)$/.test(s) || s.startsWith("/") && (normalizePath(s) === "/" || normalizePath(s) === normalizePath(root) || /^\/(?:etc|usr|home|boot|var)$/.test(normalizePath(s))) || s === "." || s === "./")) add(node, "recursive-delete")
        }
        if (/^(?:mkfs(?:\..+)?|mkswap|wipefs|fdisk|sfdisk|parted|shred)$/.test(command) && args.some(a => /^\/dev\//.test(a))) add(node, "disk-destruction")
        if (command === "dd" && args.some(a => /^of=\/dev\//.test(a))) add(node, "disk-overwrite")
        if (/^(?:chmod|chown)$/.test(command) && args.some(a => a === "/" || /^\/(?:etc|usr|boot)(?:\/|$)/.test(a))) add(node, "system-permissions")
        if (command === "chmod" && args.some(a => /^(?:777|a\+rwx|o\+w)$/.test(a))) add(node, "world-writable", "high")
        if (/^(?:bash|sh|zsh|dash|ksh)$/.test(command)) {
          const index = args.findIndex(a => /^-[^-]*c/.test(a))
          if (index >= 0) {
            // The original argument node distinguishes literal code from expansions.
            const code = args[index + 1]
            if (code !== undefined && depth < 2 && node.childrenForFieldName("argument").some(arg => arg !== null && literal(arg) === code)) {
              const nested = await scanBash(code, root, depth + 1)
              partial ||= nested.partial
              for (const nestedHit of nested.hits) hits.push({ ...nestedHit, start: node.startIndex, end: node.endIndex, identity: node.text })
            } else partial = true
          }
        }
        if (command === "eval" || command === "source" || command === ".") partial = true
      }
      if (node.type === "pipeline") {
        const cmds = node.namedChildren.filter((n): n is Node => n?.type === "command").map(n => unwrap(commands(n)))
        if (cmds.some(c => /^(?:curl|wget)$/.test(base(c[0] ?? ""))) && cmds.some(c => /^(?:bash|sh|zsh|dash|python\d*|node|perl|ruby)$/.test(base(c[0] ?? "")))) add(node, "download-execute")
      }
      if (node.type === "file_redirect" && /^\s*(?:\d+)?(?:>|>>|&>)/.test(node.text)) {
        const target = node.childForFieldName("destination")
        const value = target && literal(target)
        if (value && (sensitivePath(value) || /^\/(?:dev\/(?:sd|nvme)|etc\/)/.test(value))) add(node, "sensitive-overwrite")
        if (!value) partial = true
      }
      nodes.push(...node.namedChildren.filter((n): n is Node => n !== null))
    }
    return { hits, partial }
  } finally { tree.delete(); parser.delete() }
}
