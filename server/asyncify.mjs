import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

/**
 * Mark every function that directly contains an `await` as `async`, and wrap
 * its declared return type in `Promise<>`. Text edits, applied back to front.
 */
function asyncify(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const edits = [];

  const isFn = (n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isGetAccessorDeclaration(n);

  /** Does `node` contain an await that belongs to it (not to a nested fn)? */
  function hasOwnAwait(node) {
    let found = false;
    const walk = (n) => {
      if (found) return;
      if (n !== node && isFn(n)) return;
      if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) {
        found = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(node, walk);
    return found;
  }

  const visit = (node) => {
    if (isFn(node) && !ts.isGetAccessorDeclaration(node) && hasOwnAwait(node)) {
      const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (!isAsync) {
        // `async` goes before `function`, before the parameter list of an
        // arrow, and before the name of a method.
        let at;
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          at = node.getStart(sf);
        } else if (ts.isMethodDeclaration(node)) {
          at = (node.modifiers?.[0] ?? node.name).getStart(sf);
        } else {
          const fnKeyword = node.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
          at = (fnKeyword ?? node).getStart(sf);
        }
        edits.push({ start: at, end: at, text: "async " });
      }
      const rt = node.type;
      if (rt && !/^Promise</.test(rt.getText(sf)) && !/^AsyncGenerator/.test(rt.getText(sf))) {
        edits.push({ start: rt.getStart(sf), end: rt.getEnd(), text: `Promise<${rt.getText(sf)}>` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length === 0) return false;
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  writeFileSync(file, out);
  return true;
}

for (const file of process.argv.slice(2)) {
  if (asyncify(file)) console.log("asyncified", file);
}
