/**
 * Gates for the build step that shortens internal property names (scripts/mangle.mjs). Renaming a
 * property is only safe when every use of it is known, so these gates look for the two ways that
 * goes wrong:
 *
 *   1. a name the public API exposes is renamed (users' code would no longer find it);
 *   2. a renamed key is read with a runtime string (`table[key]`, `key in table`,
 *      `Object.keys(table)`, `for (key in table)`), so the lookup silently finds nothing.
 */
import { internalNames } from '../../mangle.mjs';
import { abs, fail, getSourceFile, lineOf, pass, sourceFiles, ts } from '../lib.mjs';

/** Every property, method and parameter name reachable from the package's exported types. */
export const publicApiNames = () => {
  const entry = abs('dist/types/index.d.ts');
  const program = ts.createProgram([entry], { noEmit: true, skipLibCheck: true, strict: true });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry));
  const names = new Set();
  const seen = new Set();
  const isLibrary = (declaration) =>
    /[\\/]node_modules[\\/]/.test(declaration.getSourceFile().fileName);
  const isHidden = (declaration) =>
    (ts.getCombinedModifierFlags(declaration) &
      (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
    0;

  const visitSignature = (signature) => {
    for (const parameter of signature.getParameters()) {
      names.add(parameter.getName());
      const declaration = parameter.valueDeclaration;
      if (declaration) visitType(checker.getTypeOfSymbolAtLocation(parameter, declaration));
    }
    visitType(signature.getReturnType());
  };

  const visitType = (type) => {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.isUnionOrIntersection()) type.types.forEach(visitType);
    for (const argument of checker.getTypeArguments?.(type) ?? []) visitType(argument);
    // Promise<T>, Array<T> and other library types: only their type arguments are ours.
    const declarations = type.getSymbol()?.getDeclarations() ?? [];
    if (declarations.length > 0 && declarations.every(isLibrary)) return;
    for (const property of type.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration || isLibrary(declaration) || isHidden(declaration)) continue;
      names.add(property.getName());
      visitType(checker.getTypeOfSymbolAtLocation(property, declaration));
    }
    type.getCallSignatures().forEach(visitSignature);
    type.getConstructSignatures().forEach(visitSignature);
  };

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) continue;
    if (symbol.flags & ts.SymbolFlags.Value) {
      visitType(checker.getTypeOfSymbolAtLocation(symbol, declaration));
    }
    if (symbol.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Class)) {
      visitType(checker.getDeclaredTypeOfSymbol(symbol));
    }
  }
  return names;
};

/** The object literal a variable is initialized with (through `as`, `satisfies` and parentheses). */
const literalOf = (declaration) => {
  let node = declaration?.initializer;
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node))
  ) {
    node = node.expression;
  }
  return node && ts.isObjectLiteralExpression(node) ? node : undefined;
};

/** Keys of an object literal written as plain identifiers (the ones the build may rename). */
const identifierKeys = (literal) =>
  literal.properties
    .filter(
      (property) =>
        (ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property)) &&
        ts.isIdentifier(property.name)
    )
    .map((property) => property.name.text);

/**
 * Places in src where an object literal's renamed keys are read with runtime strings.
 * @param renamed - Names the build renames
 * @returns Problems, as "path:line message"
 */
export const dynamicKeyUses = (renamed) => {
  const problems = [];
  for (const path of sourceFiles()) {
    const file = getSourceFile(path);
    // Variables in this file initialized with an object literal, by name.
    const literals = new Map();
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const literal = literalOf(node);
        if (literal) literals.set(node.name.text, literal);
      }
      ts.forEachChild(node, collect);
    };
    collect(file);

    const report = (node, expression, how) => {
      let target = expression;
      while (
        ts.isAsExpression(target) ||
        ts.isSatisfiesExpression(target) ||
        ts.isParenthesizedExpression(target) ||
        ts.isNonNullExpression(target)
      ) {
        target = target.expression;
      }
      if (!ts.isIdentifier(target)) return;
      const literal = literals.get(target.text);
      if (!literal) return;
      const keys = identifierKeys(literal).filter((key) => renamed.has(key));
      if (keys.length === 0) return;
      problems.push(
        `${path}:${lineOf(file, node)} ${target.text} is ${how}, but the build renames its keys ` +
          `(${keys.join(', ')}). Use a Map, or type it Record<string, T>.`
      );
    };

    const visit = (node) => {
      if (
        ts.isElementAccessExpression(node) &&
        !ts.isStringLiteralLike(node.argumentExpression) &&
        !ts.isNumericLiteral(node.argumentExpression)
      ) {
        report(node, node.expression, 'indexed with a runtime key');
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        !ts.isStringLiteralLike(node.left)
      ) {
        report(node, node.right, 'checked with `in` and a runtime key');
      }
      if (ts.isForInStatement(node)) report(node, node.expression, 'iterated with for...in');
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Object' &&
        ['keys', 'entries', 'getOwnPropertyNames'].includes(node.expression.name.text) &&
        node.arguments[0]
      ) {
        report(node, node.arguments[0], `read with Object.${node.expression.name.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return problems;
};

export const mangleGates = [
  {
    category: 'package',
    dependsOn: ['build'],
    description:
      'The build only renames internal names: no name reachable from the exported types (found ' +
      'with the type checker) is renamed, and no renamed object key is read with a runtime string.',
    id: 'mangle-safety',
    run: async () => {
      const renamed = new Set(internalNames());
      const publicNames = publicApiNames();
      const exposed = [...publicNames].filter((name) => renamed.has(name)).sort();
      const problems = [
        ...exposed.map(
          (name) =>
            `"${name}" is part of the public API but the build renames it (scripts/mangle.mjs)`
        ),
        ...dynamicKeyUses(renamed)
      ];
      return problems.length === 0
        ? pass(
            `${renamed.size} renamed names; none of ${publicNames.size} public names, no dynamic key use`
          )
        : fail(`${problems.length} unsafe rename(s)`, problems);
    },
    title: 'Safe internal-name shortening'
  }
];
