const fs = require('fs');
const path = require('path');

let cachedExportMap = null;

function getLucideExportMap() {
  if (cachedExportMap) return cachedExportMap;
  const map = new Map();
  const entryPath = path.resolve(
    __dirname,
    '../node_modules/lucide-react-native/dist/esm/lucide-react-native.js'
  );
  if (!fs.existsSync(entryPath)) {
    cachedExportMap = map;
    return map;
  }

  const content = fs.readFileSync(entryPath, 'utf8');
  const exportRegex = /export\s*\{([^}]+)\}\s*from\s*'(\.\/icons\/[^']+)'/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    const relativeTarget = match[2].replace(/^\.\//, 'lucide-react-native/dist/esm/');
    const specifiers = match[1].split(',');
    for (const raw of specifiers) {
      const asMatch = raw.trim().match(/^default\s+as\s+([A-Za-z0-9_$]+)$/);
      if (asMatch) {
        map.set(asMatch[1], relativeTarget);
      }
    }
  }

  cachedExportMap = map;
  return map;
}

function buildTypeOnlyImportDecl(t, specifiers, sourceValue) {
  const cleanSpecifiers = specifiers.map((spec) =>
    t.importSpecifier(t.identifier(spec.local.name), t.cloneNode(spec.imported))
  );
  const decl = t.importDeclaration(cleanSpecifiers, t.stringLiteral(sourceValue));
  decl.importKind = 'type';
  return decl;
}

function buildTypeOnlyExportDecl(t, specifiers, sourceValue) {
  const cleanSpecifiers = specifiers.map((spec) =>
    t.exportSpecifier(t.cloneNode(spec.local), t.cloneNode(spec.exported))
  );
  const decl = t.exportNamedDeclaration(null, cleanSpecifiers, t.stringLiteral(sourceValue));
  decl.exportKind = 'type';
  return decl;
}

module.exports = function babelPluginLucideDirectImports({ types: t }) {
  const exportMap = getLucideExportMap();

  return {
    name: 'lucide-direct-imports',
    visitor: {
      ImportDeclaration(importPath) {
        const node = importPath.node;
        if (!node || !node.source || node.source.value !== 'lucide-react-native') return;
        if (node.importKind === 'type' || node.importKind === 'typeof') return;
        if (!exportMap.size) return;

        const replacements = [];
        const remaining = [];

        for (const spec of node.specifiers) {
          if (
            t.isImportSpecifier(spec) &&
            spec.importKind !== 'type' &&
            spec.importKind !== 'typeof'
          ) {
            const importedName = t.isIdentifier(spec.imported)
              ? spec.imported.name
              : spec.imported.value;
            const target = exportMap.get(importedName);
            if (target) {
              replacements.push(
                t.importDeclaration(
                  [t.importDefaultSpecifier(t.identifier(spec.local.name))],
                  t.stringLiteral(target)
                )
              );
              continue;
            }
          }
          remaining.push(spec);
        }

        const allRemainingTypeOnly =
          remaining.length > 0 &&
          remaining.every((spec) => t.isImportSpecifier(spec) && spec.importKind === 'type');

        if (replacements.length === 0) {
          if (allRemainingTypeOnly) {
            importPath.replaceWith(buildTypeOnlyImportDecl(t, remaining, 'lucide-react-native'));
          }
          return;
        }

        if (remaining.length > 0) {
          if (allRemainingTypeOnly) {
            replacements.push(buildTypeOnlyImportDecl(t, remaining, 'lucide-react-native'));
          } else {
            replacements.push(t.importDeclaration(remaining, t.stringLiteral('lucide-react-native')));
          }
        }
        importPath.replaceWithMultiple(replacements);
      },

      ExportNamedDeclaration(exportPath) {
        const node = exportPath.node;
        if (!node || !node.source || node.source.value !== 'lucide-react-native') return;
        if (node.exportKind === 'type') return;
        if (!exportMap.size) return;

        const replacements = [];
        const remaining = [];

        for (const spec of node.specifiers) {
          if (t.isExportSpecifier(spec) && spec.exportKind !== 'type') {
            const sourceName = t.isIdentifier(spec.local)
              ? spec.local.name
              : t.isStringLiteral(spec.local)
                ? spec.local.value
                : null;
            const target = sourceName ? exportMap.get(sourceName) : null;
            if (target) {
              replacements.push(
                t.exportNamedDeclaration(
                  null,
                  [t.exportSpecifier(t.identifier('default'), t.cloneNode(spec.exported))],
                  t.stringLiteral(target)
                )
              );
              continue;
            }
          }
          remaining.push(spec);
        }

        const allRemainingTypeOnly =
          remaining.length > 0 &&
          remaining.every((spec) => t.isExportSpecifier(spec) && spec.exportKind === 'type');

        if (replacements.length === 0) {
          if (allRemainingTypeOnly) {
            exportPath.replaceWith(buildTypeOnlyExportDecl(t, remaining, 'lucide-react-native'));
          }
          return;
        }

        if (remaining.length > 0) {
          if (allRemainingTypeOnly) {
            replacements.push(buildTypeOnlyExportDecl(t, remaining, 'lucide-react-native'));
          } else {
            replacements.push(
              t.exportNamedDeclaration(null, remaining, t.stringLiteral('lucide-react-native'))
            );
          }
        }
        exportPath.replaceWithMultiple(replacements);
      },
    },
  };
};
