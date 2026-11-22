module.exports = function (api) {
  const isCallerProd = api.caller((c) => Boolean(c && c.isDev === false));
  api.cache.using(() => `${process.env.NODE_ENV || 'development'}:${process.env.BABEL_ENV || ''}`);
  const isProd =
    isCallerProd ||
    process.env.NODE_ENV === 'production' ||
    process.env.BABEL_ENV === 'production';

  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ...(isProd ? ['transform-remove-console'] : []),
    ],
  };
};
