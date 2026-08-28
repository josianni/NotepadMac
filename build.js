const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'renderer', 'app.js')],
  bundle: true,
  outfile: path.join(__dirname, 'renderer', 'bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  minify: false,
});

console.log('Build complete: renderer/bundle.js');
