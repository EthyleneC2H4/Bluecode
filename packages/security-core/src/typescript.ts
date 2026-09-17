import ts from "typescript"
import { hit, type Hit, type Scan } from "./model"

function staticValue(node: ts.Node | undefined, depth = 0): string | undefined {
  if (!node || depth > 64) return undefined
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return staticValue(node.expression, depth + 1)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = staticValue(node.left, depth + 1), b = staticValue(node.right, depth + 1)
    return a === undefined || b === undefined ? undefined : a + b
  }
  return undefined
}
function name(node: ts.Node | undefined): string {
  if (!node) return ""
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return name(node.expression) + "." + node.name.text
  if (ts.isElementAccessExpression(node)) { const key = staticValue(node.argumentExpression); return key === undefined ? "" : name(node.expression) + "." + key }
  return ""
}
function sanitized(node: ts.Node | undefined): boolean {
  return !!node && ts.isCallExpression(node) && /^(?:DOMPurify\.sanitize|sanitizeHtml|escapeHtml|escapeHTML)$/.test(name(node.expression))
}
function dynamic(node: ts.Node | undefined): boolean {
  return !!node && staticValue(node) === undefined && !sanitized(node)
}
function concatenated(node: ts.Node | undefined): boolean {
  return !!node && dynamic(node) && (ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) || (ts.isCallExpression(node) && /\.concat$/.test(name(node.expression))))
}
function number(node: ts.Node | undefined): number | undefined {
  return node && ts.isNumericLiteral(node) ? Number(node.text) : undefined
}

/** Syntax analysis only: no program resolution, module loading or source execution. */
export function scanTypeScript(text: string, path: string): Scan {
  const kind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile("input", text, ts.ScriptTarget.Latest, true, kind)
  const parse = source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  const hits: Hit[] = []
  const constants = new Map<string, ts.Expression>()
  const add = (node: ts.Node, category: Hit["category"], suffix: string, severity: Hit["severity"] = "high") => {
    const start = node.getStart(source)
    hits.push(hit(category, suffix, start, node.end, text.slice(start, node.end), severity))
  }
  const nodes: ts.Node[] = [source]
  while (nodes.length) {
    const node = nodes.pop()!
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer)
    ts.forEachChild(node, child => { nodes.push(child) })
  }
  nodes.push(source)
  while (nodes.length) {
    const node = nodes.pop()!
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = name(node.expression), method = callee.split(".").at(-1) ?? ""
      const args = node.arguments ?? []
      if (/^(?:eval|window\.eval|globalThis\.eval|Function|window\.Function|globalThis\.Function)$/.test(callee) && args.some(dynamic)) add(node, "dynamic-execution", "code-string")
      if (/^(?:vm\.)?(?:runInNewContext|runInThisContext|runInContext|compileFunction)$/.test(callee) && dynamic(args[0])) add(node, "dynamic-execution", "vm-code")
      if (/^(?:(?:child_process|cp)\.)?(?:exec|execSync)$/.test(callee) && dynamic(args[0])) add(node, "dynamic-execution", "shell-string")
      if (/^(?:(?:window|globalThis)\.)?set(?:Timeout|Interval)$/.test(callee) && args[0] && !ts.isArrowFunction(args[0]) && !ts.isFunctionExpression(args[0]) && dynamic(args[0])) add(node, "dynamic-execution", "timer-string", "medium")
      if (/^(?:query|execute|exec|raw)$/.test(method) && concatenated(args[0])) add(node, "sql-injection", "constructed-query")
      if ((/^(?:document\.write|document\.writeln)$/.test(callee) && args.some(dynamic)) || (method === "insertAdjacentHTML" && dynamic(args[1]))) add(node, "xss", "html-call")
      // jQuery roots are call expressions and intentionally do not share the generic name helper.
      if (ts.isPropertyAccessExpression(node.expression) && /^(?:html|append|prepend)$/.test(node.expression.name.text)
        && ts.isCallExpression(node.expression.expression) && /^(?:\$|jQuery)$/.test(name(node.expression.expression.expression)) && dynamic(args[0])) add(node, "xss", "jquery-html")
      const algorithm = staticValue(args[0])?.toLowerCase().replaceAll("-", "")
      if (/^(?:createHash|createHmac)$/.test(method) && algorithm && /^(?:md4|md5|sha1)$/.test(algorithm)) add(node, "weak-crypto", "weak-digest", "medium")
      if (/^(?:createCipher|createDecipher|createCipheriv|createDecipheriv)$/.test(method) && algorithm && /^(?:des|3des|rc2|rc4|bf|aes.*ecb)/.test(algorithm)) add(node, "weak-crypto", "weak-cipher")
      if (method === "createCipher") add(node, "weak-crypto", "legacy-cipher")
      if (/^(?:createCipheriv|createDecipheriv)$/.test(method) && args[2]) {
        let iv: ts.Node = args[2]
        if (ts.isIdentifier(iv)) iv = constants.get(iv.text) ?? iv
        if (staticValue(iv) !== undefined || (ts.isCallExpression(iv) && name(iv.expression) === "Buffer.alloc" && (iv.arguments.length === 1 || number(iv.arguments[1]) === 0))) add(node, "weak-crypto", "fixed-iv")
      }
      if (/^pbkdf2(?:Sync)?$/.test(method) && number(args[2]) !== undefined && number(args[2])! < 100000) add(node, "weak-crypto", "low-kdf-cost")
      if (/^generateKeyPair(?:Sync)?$/.test(method) && staticValue(args[0]) === "rsa" && args[1] && ts.isObjectLiteralExpression(args[1])) {
        const prop = args[1].properties.find(p => ts.isPropertyAssignment(p) && name(p.name) === "modulusLength")
        if (prop && ts.isPropertyAssignment(prop) && number(prop.initializer) !== undefined && number(prop.initializer)! < 2048) add(node, "weak-crypto", "short-rsa-key")
      }
      if (/^(?:Math\.random|Date\.now)$/.test(callee)) {
        let ancestor: ts.Node | undefined = node.parent
        for (let i = 0; ancestor && i < 5; i++, ancestor = ancestor.parent) {
          if (ts.isVariableDeclaration(ancestor) || ts.isPropertyAssignment(ancestor)) {
            if (/(?:token|secret|password|nonce|salt|iv|key)/i.test(name(ancestor.name))) add(node, "weak-crypto", "predictable-secret")
            break
          }
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.(?:innerHTML|outerHTML|srcdoc)$/.test(name(node.left)) && dynamic(node.right)) add(node, "xss", "html-assignment")
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "dangerouslySetInnerHTML" && node.initializer && ts.isJsxExpression(node.initializer)) {
      const expr = node.initializer.expression
      if (expr && ts.isObjectLiteralExpression(expr)) {
        const prop = expr.properties.find(p => ts.isPropertyAssignment(p) && name(p.name) === "__html")
        if (prop && ts.isPropertyAssignment(prop) && dynamic(prop.initializer)) add(node, "xss", "react-html")
      } else if (dynamic(expr)) add(node, "xss", "react-html")
    }
    ts.forEachChild(node, child => { nodes.push(child) })
  }
  return { hits, partial: !!parse.parseDiagnostics?.length }
}
