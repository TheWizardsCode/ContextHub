import * as fs from 'node:fs';
import ts from 'typescript';
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf-8');
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
for (const stmt of sf.statements) {
  const kind = ts.SyntaxKind[stmt.kind];
  let name = '';
  const anyStmt = stmt as any;
  if (anyStmt.name && ts.isIdentifier(anyStmt.name)) name = anyStmt.name.text;
  if (ts.isVariableStatement(stmt)) {
    name = stmt.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : '?')).join(',');
  }
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
    // include leading JSDoc block
  }
  let start = stmt.getStart(sf);
  // find leading comment
  const ranges = ts.getLeadingCommentRanges(src, stmt.getFullStart()) ?? [];
  let leadingStart = start;
  for (const r of ranges) {
    const text = src.slice(r.pos, r.end);
    if (text.startsWith('/**')) leadingStart = Math.min(leadingStart, r.pos);
  }
  console.log(`${leadingStart}\t${start}\t${stmt.getEnd()}\t${lineOf(leadingStart)}\t${lineOf(stmt.getEnd())}\t${kind}\t${name}`);
}
