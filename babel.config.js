module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV || 'development');
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ...(process.env.NODE_ENV === 'production' ? ['transform-remove-console'] : []),
      './plugins/babel-plugin-lucide-direct-imports',
    ],
  };
};
