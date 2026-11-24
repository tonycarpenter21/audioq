/**
 * Reads the public API of each entry point ('audioq' = src/index.ts, 'audioq/queue' =
 * src/queue.ts) with the TypeScript checker. Used by the API snapshot gate, the README coverage
 * gate and `npm run api:update`.
 */
import { abs, ts } from './lib.mjs';

/** Path of the committed API snapshot. */
export const API_SNAPSHOT_PATH = 'api/public-api.json';

const compilerOptions = {
  lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2020,
  types: []
};

const describeSymbol = (checker, symbol) => {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = target.declarations?.[0];
  // Plain type names: fully qualified names embed absolute file paths, which differ per machine.
  const flags = ts.TypeFormatFlags.NoTruncation;
  if (!declaration) return { kind: 'unknown', signature: '' };
  if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
    const type = checker.getDeclaredTypeOfSymbol(target);
    if (ts.isTypeAliasDeclaration(declaration)) {
      return { kind: 'type', signature: declaration.type.getText() };
    }
    const members = checker
      .getPropertiesOfType(type)
      .map((property) => {
        const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
        const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
        return `${property.name}${optional}: ${checker.typeToString(propertyType, undefined, flags)}`;
      })
      .sort();
    return { kind: 'interface', signature: `{ ${members.join('; ')} }` };
  }
  if (ts.isEnumDeclaration(declaration)) {
    const members = declaration.members.map(
      (m) => `${m.name.getText()} = ${m.initializer?.getText()}`
    );
    return { kind: 'enum', signature: members.join(', ') };
  }
  if (ts.isClassDeclaration(declaration)) {
    const instance = checker.getDeclaredTypeOfSymbol(target);
    const isPublic = (property) =>
      !(property.declarations ?? []).some(
        (decl) =>
          (ts.getCombinedModifierFlags(decl) &
            (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
          0
      );
    const members = checker
      .getPropertiesOfType(instance)
      .filter(isPublic)
      .map((property) => {
        const type = checker.getTypeOfSymbolAtLocation(property, declaration);
        return `${property.name}: ${checker.typeToString(type, undefined, flags)}`;
      })
      .sort();
    return { kind: 'class', signature: `{ ${members.join('; ')} }` };
  }
  const type = checker.getTypeOfSymbolAtLocation(target, declaration);
  const kind = type.getCallSignatures().length > 0 ? 'function' : 'const';
  return { kind, signature: checker.typeToString(type, undefined, flags) };
};

/** Source file of each package entry point, keyed by the specifier users import. */
export const ENTRY_POINTS = { audioq: 'src/index.ts', 'audioq/queue': 'src/queue.ts' };

/**
 * Describes every export of one entry point's source file.
 * @param {string} [source] the entry point's source file (default: src/index.ts)
 * @returns {Record<string, { kind: string, signature: string }>} sorted by name
 */
export const readPublicApi = (source = ENTRY_POINTS.audioq) => {
  const entry = abs(source);
  const program = ts.createProgram([entry], compilerOptions);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry));
  const result = {};
  for (const symbol of checker
    .getExportsOfModule(moduleSymbol)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    result[symbol.name] = describeSymbol(checker, symbol);
  }
  return result;
};

/**
 * Describes every entry point: exports of 'audioq' under their own name, exports of other entry
 * points as `<specifier>:<name>` (for example `audioq/queue:queueAudio`).
 */
export const readPublishedApi = () => {
  const result = {};
  for (const [specifier, source] of Object.entries(ENTRY_POINTS)) {
    for (const [name, description] of Object.entries(readPublicApi(source))) {
      result[specifier === 'audioq' ? name : `${specifier}:${name}`] = description;
    }
  }
  return result;
};

/** Names of runtime (value) exports. */
export const runtimeApiNames = (api = readPublicApi()) =>
  Object.entries(api)
    .filter(([, { kind }]) => ['function', 'const', 'class', 'enum'].includes(kind))
    .map(([name]) => name);
