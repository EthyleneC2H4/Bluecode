import { Parser, Language, type Node } from "web-tree-sitter"
import { hit, type Hit, type Scan } from "./model"
import { normalizePath, sensitivePath, within } from "./paths"

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
  if (node.type === "ansi_c_string") {
    let supported = true
    const value = node.text.slice(2, -1).replace(/\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g, (_, escape: string) => {
      const simple: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' }
      if (simple[escape] !== undefined) return simple[escape]!
      if (/^[xuU][\da-fA-F]+$|^[0-7]+$/.test(escape)) {
        const point = Number.parseInt(/^[xuU]/.test(escape) ? escape.slice(1) : escape, /^[xuU]/.test(escape) ? 16 : 8)
        if (point <= 0x10ffff) return String.fromCodePoint(/^[0-7]/.test(escape) ? point & 255 : point)
      }
      supported = false
      return ""
    })
    return supported ? value.split("\0")[0] : undefined
  }
  if (node.type === "word" || node.type === "number") return node.text.replace(/\\\n/g, "").replace(/\\(.)/g, "$1")
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
      if (word === "--help" || word === "--version" || wrapper === "command" && /^-[^-]*[vV]/.test(word) ||
          wrapper === "sudo" && (word === "--list" || /^-[^-]*l/.test(word))) return []
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
export async function scanBash(text: string, root: string, depth = 0, cwd = root): Promise<Scan> {
  const grammar = await language()
  const parser = new Parser()
  parser.setLanguage(grammar)
  const tree = parser.parse(text)
  if (!tree) { parser.delete(); return { hits: [], partial: true } }
  const hits: Hit[] = []
  let partial = tree.rootNode.hasError
  const add = (node: Node, suffix: string, severity: Hit["severity"] = "critical") => hits.push(hit("dangerous-command", suffix, node.startIndex, node.endIndex, node.text, severity))
  const inspectPath = (node: Node, value: string) => {
    if (!value || value === "-" || /[$`*?{}]/.test(value)) { partial = true; return }
    const resolved = normalizePath(value.startsWith("/") ? value : `${cwd}/${value}`)
    if (/^\/dev\/(?:null|stdin|stdout|stderr)$/.test(resolved)) return
    if (sensitivePath(resolved)) hits.push(hit("sensitive-file", "shell-path", node.startIndex, node.endIndex, node.text, "critical"))
    if (!within(resolved, root)) hits.push(hit("path-traversal", "shell-path", node.startIndex, node.endIndex, node.text, "critical"))
    // Canonical filesystem evidence is available for direct tools only. Shell
    // symlinks and preceding cd/assignments cannot be proved by this syntax pass.
    partial = true
  }
  const commands = (node: Node): string[] => {
    const name = node.childForFieldName("name")
    const args = node.childrenForFieldName("argument")
    const parts = [name, ...args].filter((n): n is Node => n !== null)
    const words: string[] = []
    for (let index = 0; index < parts.length; index++) {
      const n = parts[index]!
      const value = literal(n)
      if (value === undefined) partial = true
      // The pinned grammar splits unquoted line continuations into words.
      const previous = parts[index - 1]
      if (previous && /^(?:\\\n)+$/.test(text.slice(previous.endIndex, n.startIndex))) words[words.length - 1] += value ?? n.text
      else words.push(value ?? n.text)
    }
    return words
  }
  const stageWords = (node: Node): string[] | undefined => {
    if (node.type === "command") return unwrap(commands(node))
    if (["subshell", "compound_statement"].includes(node.type)) {
      const children = node.namedChildren.filter((n): n is Node => n !== null && n.type !== "comment")
      if (children.length === 1) return stageWords(children[0]!)
    }
    partial = true
    return undefined
  }
  const consumesCode = (words: string[]): boolean => {
    const command = base(words[0] ?? ""), args = words.slice(1)
    if (!/^(?:bash|sh|zsh|dash|ksh|python\d*|node|perl|ruby)$/.test(command)) return false
    if (/^(?:bash|sh|zsh|dash|ksh)$/.test(command)) {
      let stdin = false
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (/^-[^-]*c/.test(arg)) return false
        if (/^-[^-]*s/.test(arg)) stdin = true
        if (/^(?:[-+]o|[-+]O|--rcfile|--init-file)$/.test(arg)) { i++; continue }
        if (arg === "--") return stdin || i === args.length - 1
        if (arg !== "-" && !/^[-+]/.test(arg)) return stdin
      }
      return true
    }
    // Explicit programs/files are independent of the pipe's code stream.
    if (args.some(a => /^-[^-]*[ce]/.test(a) || /^(?:--eval|--print)(?:=|$)/.test(a))) return false
    return !args.some(a => a !== "-" && !a.startsWith("-"))
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
        const optionsEnd = args.indexOf("--")
        const help = args.slice(0, optionsEnd < 0 ? args.length : optionsEnd).some(a => a === "--help" || a === "--version")
        if (/^(?:cat|head|tail|stat|cp|mv|tee|source|\.)$/.test(command) && !help) {
          for (let i = 0; i < args.length; i++) {
            const arg = args[i]!
            if (arg === "--" && i === optionsEnd) continue
            if (optionsEnd >= 0 && i > optionsEnd) { inspectPath(node, arg); continue }
            if (/^(?:head|tail)$/.test(command) && /^(?:-[nc]|--lines|--bytes)$/.test(arg) ||
                command === "stat" && /^(?:-f|-c|--format|--printf)$/.test(arg) ||
                /^(?:cp|mv)$/.test(command) && /^(?:-S|--suffix)$/.test(arg)) { i++; continue }
            if (/^(?:cp|mv)$/.test(command) && arg.startsWith("--target-directory=")) inspectPath(node, arg.slice("--target-directory=".length))
            if (!arg.startsWith("-")) inspectPath(node, arg)
          }
        }
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
              const nested = await scanBash(code, root, depth + 1, cwd)
              partial ||= nested.partial
              for (const nestedHit of nested.hits) hits.push({ ...nestedHit, start: node.startIndex, end: node.endIndex, identity: node.text })
            } else partial = true
          }
        }
        if (command === "eval" || command === "source" || command === ".") partial = true
      }
      if (node.type === "pipeline") {
        let downloaded = false
        for (const stage of node.namedChildren.filter((n): n is Node => n !== null)) {
          const words = stageWords(stage)
          if (!words) { downloaded = false; continue }
          if (downloaded && consumesCode(words)) { add(node, "download-execute"); break }
          const command = base(words[0] ?? ""), args = words.slice(1)
          if (command === "curl") downloaded = !args.some((a, i) => /^(?:-o|--output)$/.test(a) && args[i + 1] !== "-" || /^--output=(?!-$)/.test(a) || /^-o[^-]/.test(a) || a === "-O" || a === "--remote-name")
          else if (command === "wget") downloaded = args.some((a, i) => /^(?:-O|--output-document)$/.test(a) && args[i + 1] === "-" || /^-[^-]*O-$/.test(a) || a === "--output-document=-")
          else if (command === "cat") downloaded &&= args.length === 0 || args.includes("-")
          else if (/^(?:tee|sed|awk|grep|tr|head|tail)$/.test(command)) { /* Supported stream processors preserve dependency. */ }
          else downloaded = false
        }
      }
      if (node.type === "file_redirect" && /^\s*(?:\d+)?(?:>|>>|&>)/.test(node.text)) {
        const target = node.childForFieldName("destination")
        const value = target && literal(target)
        if (value && (sensitivePath(value) || /^\/(?:dev\/(?:sd|nvme)|etc\/)/.test(value))) add(node, "sensitive-overwrite")
        if (!value) partial = true
      }
      if (node.type === "file_redirect") {
        const target = node.childForFieldName("destination")
        const value = target && literal(target)
        if (value && value !== "&1" && value !== "&2" && !/^\d+$/.test(value)) inspectPath(node, value)
      }
      nodes.push(...node.namedChildren.filter((n): n is Node => n !== null))
    }
    return { hits, partial }
  } finally { tree.delete(); parser.delete() }
}
