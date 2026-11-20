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
      const asMatch = raw.trim().match(/^default\s+as\s+([A-Za-z0-9_]+)$/);
      if (asMatch) {
        map.set(asMatch[1], relativeTarget);
      }
    }
  }

  cachedExportMap = map;
  return map;
}

module.exports = function babelPluginLucideDirectImports({ types: t }) {
  const exportMap = getLucideExportMap();

  return {
    name: 'lucide-direct-imports',
    visitor: {
      ImportDeclaration(importPath) {
        const node = importPath.node;
        if (!node || node.source.value !== 'lucide-react-native') return;
        if (node.importKind === 'type' || node.importKind === 'typeof') return;
        if (!exportMap.size) return;

        const replacements = [];
        const remaining = [];

        for (const spec of node.specifiers) {
          if (t.isImportSpecifier(spec) && spec.importKind !== 'type') {
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

        if (replacements.length === 0) return;

        if (remaining.length > 0) {
          replacements.push(t.importDeclaration(remaining, t.stringLiteral('lucide-react-native')));
        }
        importPath.replaceWithMultiple(replacements);
      },
    },
  };
};
