// Copyright 2022 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// @ts-check

const os = require('os');
const path = require('path');

const {devtoolsRootPath} = require('../devtools_paths.js');

const {esbuildPlugin} = require('./devtools_plugin.js');

// esbuild module uses binary in this path.
const binaryName = os.type() === 'Windows_NT' ? 'esbuild.exe' : 'esbuild';
process.env.ESBUILD_BINARY_PATH = path.join(
    devtoolsRootPath(),
    'third_party',
    'esbuild',
    binaryName,
);
// This needs to be after the ESBUILD_BINARY_PATH is set
// eslint-disable-next-line import/order
const esbuild = require('esbuild');

const entryPoints = [process.argv[2]];
const outfile = process.argv[3];
const useSourceMaps = process.argv.slice(4).includes('--configSourcemaps');

const outdir = path.dirname(outfile);

const plugin = {
  name: 'devtools-plugin',
  setup(build) {
    // https://esbuild.github.io/plugins/#on-resolve
    build.onResolve({filter: /.*/}, esbuildPlugin(outdir));
  },
};

// guojinghua@lexmount: single bundle plugin is used to bundle compiled sources instead of already bundled modules. Otherwise a file imported both directly and through a module bundle would be initialized twice. esbuild also preserves lazy initialization for inlined dynamic imports.
const {singleBundlePlugin, writeDepfile} = require('./single_bundle_plugin.js');
const bundleAll = process.argv.slice(4).includes('--bundle-all');
const minify = process.argv.slice(4).includes('--minify');

esbuild
    .build({
      entryPoints,
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',

      // guojinghua@lexmount
      plugins: [bundleAll ? singleBundlePlugin(outfile, useSourceMaps) : plugin],

      sourcemap: useSourceMaps,

      // guojinghua@lexmount
      minify,
      metafile: bundleAll,
      write: !bundleAll,

    })

    // guojinghua@lexmount
    .then(result => {
      if (bundleAll) {
        // Keep unchanged output timestamps stable for Ninja's restat handling.
        const {writeIfChanged} = require('./ninja/write-if-changed.js');
        for (const output of result.outputFiles) {
          writeIfChanged(output.path, output.text);
        }
        writeDepfile(outfile, result.metafile);
      }
    })
    .catch(err => {
      console.error('Failed to run esbuild:', err);
      console.error(
          '\nIf error includes `Host version "X" does not match binary version "Y", you need to run `gclient sync`',
      );
      process.exit(1);
    });
