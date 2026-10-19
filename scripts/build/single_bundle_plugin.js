// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// @ts-check

const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');

const {devtoolsPlugin} = require('./devtools_plugin.js');
const {writeIfChanged} = require('./ninja/write-if-changed.js');

/**
 * Bundle compiled sources instead of already bundled modules. Otherwise a file
 * imported both directly and through a module bundle would be initialized twice.
 * esbuild also preserves lazy initialization for inlined dynamic imports.
 *
 * @param {string} outfile
 * @param {boolean} sourcemap
 * @returns {import('esbuild').Plugin}
 */
function singleBundlePlugin(outfile, sourcemap) {
  return {
    name: 'devtools-single-bundle',
    setup(build) {
      build.onResolve({filter: /.*/}, args => {
        const resolved = devtoolsPlugin(args.path, args.importer);
        if (!resolved) {
          return null;
        }
        if (!path.isAbsolute(resolved.id)) {
          return {path: resolved.id, external: true};
        }
        // Puppeteer's Node-only imports must stay outside the browser bundle.
        if (resolved.id.includes(path.join('puppeteer', 'node') + path.sep)) {
          return {path: './' + path.relative(path.dirname(path.resolve(outfile)), resolved.id), external: true};
        }
        const prebundle = resolved.id.replace(/\.js$/, '.prebundle.js');
        return {path: fs.existsSync(prebundle) ? prebundle : resolved.id};
      });

      build.onLoad({filter: /\.[cm]?js$/}, async args => {
        let contents = await fs.promises.readFile(args.path, 'utf8');
        if (!contents.includes('import.meta')) {
          return null;
        }

        // Resources and Workers still live next to the original modules. Make
        // import.meta.url/resolve refer to that location after moving the code.
        const originalPath = args.path.replace(/\.prebundle\.js$/, '.js');
        const relativePath = './' + path.relative(path.dirname(path.resolve(outfile)), originalPath)
                                       .split(path.sep).join('/');
        const banner = `const __devtoolsImportMeta = {
          url: new URL(${JSON.stringify(relativePath)}, import.meta.url).href,
          resolve(specifier) { return new URL(specifier, this.url).href; },
        };`;

        if (sourcemap) {
          const mapPath = args.path + '.map';
          if (fs.existsSync(mapPath)) {
            const map = await fs.promises.readFile(mapPath);
            contents += '\n//# sourceMappingURL=data:application/json;base64,' + map.toString('base64');
          }
        }

        // Let the parser replace import.meta without modifying strings/comments.
        const esbuild = require('esbuild');
        const result = await esbuild.transform(contents, {
          sourcefile: pathToFileURL(args.path).href,
          sourcemap: sourcemap ? 'inline' : false,
          define: {'import.meta': '__devtoolsImportMeta'},
          banner,
        });
        return {contents: result.code, loader: 'js'};
      });
    },
  };
}

/**
 * Track every consumed module, including transitive and dynamic dependencies.
 *
 * @param {string} outfile
 * @param {import('esbuild').Metafile} metafile
 */
function writeDepfile(outfile, metafile) {
  const escape = file => file.split(path.sep).join('/').replace(/\$/g, '$$$$').replace(/([ #])/g, '\\$1');
  const inputs = Object.keys(metafile.inputs);
  for (const input of [...inputs]) {
    if (fs.existsSync(input + '.map')) {
      inputs.push(input + '.map');
    }
  }
  writeIfChanged(outfile + '.d', `${escape(outfile)}: ${inputs.map(escape).join(' ')}\n`);
}

module.exports = {singleBundlePlugin, writeDepfile};
