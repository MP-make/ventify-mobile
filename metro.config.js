const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver = config.resolver || {};
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];
if (!Array.isArray(config.resolver.sourceExts)) {
  config.resolver.sourceExts = ['ts', 'tsx', 'js', 'jsx', 'json', 'cjs'];
} else if (!config.resolver.sourceExts.includes('cjs')) {
  config.resolver.sourceExts.push('cjs');
}
// Keep package.json exports disabled so Firebase v11 resolves consistently via
// react-native/browser main fields without ESM/CJS dual-package auth errors.
config.resolver.unstable_enablePackageExports = false;

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
