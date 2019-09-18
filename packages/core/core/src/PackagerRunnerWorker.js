// @flow

import type {Blob, FilePath, BundleResult} from '@parcel/types';
import type SourceMap from '@parcel/source-map';
import type {Bundle as InternalBundle, ParcelOptions} from './types';
import type ParcelConfig from './ParcelConfig';
import type InternalBundleGraph from './BundleGraph';

import {urlJoin, md5FromString, blobToStream} from '@parcel/utils';
import invariant from 'assert';
import nullthrows from 'nullthrows';
import path from 'path';
import url from 'url';

import {NamedBundle, bundleToInternalBundle} from './public/Bundle';
import {
  Bundle as BundleType,
  BundleGraph as BundleGraphType
} from '@parcel/types';
import {report} from './ReporterRunner';
import BundleGraph, {
  bundleGraphToInternalBundleGraph
} from './public/BundleGraph';
import PluginOptions from './public/PluginOptions';
import writeBundle from './writeBundle';

type Opts = {|
  config: ParcelConfig,
  options: ParcelOptions
|};

export default class PackagerRunner {
  config: ParcelConfig;
  options: ParcelOptions;
  pluginOptions: PluginOptions;
  distDir: FilePath;
  distExists: Set<FilePath>;

  constructor({config, options}: Opts) {
    this.config = config;
    this.options = options;
    this.distExists = new Set();
    this.pluginOptions = new PluginOptions(this.options);
  }

  async packageAndOptimize(
    bundle: InternalBundle,
    bundleGraph: InternalBundleGraph,
    cacheKey
  ) {
    //console.log('PACKAGING AND OPTIMIZING');
    let packaged = await this.package(bundle, bundleGraph);
    let res = await this.optimize(
      bundle,
      bundleGraph,
      packaged.contents,
      packaged.map
    );

    let map = res.map ? await this.generateSourceMap(bundle, res.map) : null;

    //console.log('WRITING TO CACHE', bundle.filePath, cacheKey);
    if (cacheKey != null) {
      await this.writeToCache(cacheKey, packaged.contents, map);
    }

    let {size} = await writeBundle({
      bundle,
      bundleGraph,
      contents: packaged.contents,
      map,
      options: this.options
    });

    return {size};
  }

  async package(
    internalBundle: InternalBundle,
    bundleGraph: InternalBundleGraph
  ): Promise<BundleResult> {
    let bundle = new NamedBundle(internalBundle, bundleGraph, this.options);
    report({
      type: 'buildProgress',
      phase: 'packaging',
      bundle
    });

    let packager = await this.config.getPackager(bundle.filePath);
    let packaged = await packager.package({
      bundle,
      bundleGraph: new BundleGraph(bundleGraph, this.options),
      getSourceMapReference: map => {
        return bundle.isInline ||
          (bundle.target.sourceMap && bundle.target.sourceMap.inline)
          ? this.generateSourceMap(bundleToInternalBundle(bundle), map)
          : path.basename(bundle.filePath) + '.map';
      },
      options: this.pluginOptions,
      getInlineBundleContents: (
        bundle: BundleType,
        bundleGraph: BundleGraphType
      ) => {
        if (!bundle.isInline) {
          throw new Error(
            'Bundle is not inline and unable to retrieve contents'
          );
        }

        return this.packageAndOptimize(
          bundleToInternalBundle(bundle),
          bundleGraphToInternalBundleGraph(bundleGraph)
        );
      }
    });

    return {
      contents:
        typeof packaged.contents === 'string'
          ? replaceReferences(
              packaged.contents,
              generateDepToBundlePath(internalBundle, bundleGraph)
            )
          : packaged.contents,
      map: packaged.map
    };
  }

  async optimize(
    internalBundle: InternalBundle,
    bundleGraph: InternalBundleGraph,
    contents: Blob,
    map?: ?SourceMap
  ): Promise<BundleResult> {
    let bundle = new NamedBundle(internalBundle, bundleGraph, this.options);
    let optimizers = await this.config.getOptimizers(bundle.filePath);
    if (!optimizers.length) {
      return {contents, map};
    }

    report({
      type: 'buildProgress',
      phase: 'optimizing',
      bundle
    });

    let optimized = {contents, map};
    for (let optimizer of optimizers) {
      optimized = await optimizer.optimize({
        bundle,
        contents: optimized.contents,
        map: optimized.map,
        options: this.pluginOptions
      });
    }

    return optimized;
  }

  generateSourceMap(bundle: InternalBundle, map: SourceMap): Promise<string> {
    // sourceRoot should be a relative path between outDir and rootDir for node.js targets
    let filePath = nullthrows(bundle.filePath);
    let sourceRoot: string = path.relative(
      path.dirname(filePath),
      this.options.projectRoot
    );
    let inlineSources = false;

    if (bundle.target) {
      if (
        bundle.target.sourceMap &&
        bundle.target.sourceMap.sourceRoot !== undefined
      ) {
        sourceRoot = bundle.target.sourceMap.sourceRoot;
      } else if (
        bundle.target.env.context === 'browser' &&
        this.options.mode !== 'production'
      ) {
        sourceRoot = '/__parcel_source_root';
      }

      if (
        bundle.target.sourceMap &&
        bundle.target.sourceMap.inlineSources !== undefined
      ) {
        inlineSources = bundle.target.sourceMap.inlineSources;
      } else if (bundle.target.env.context !== 'node') {
        // inlining should only happen in production for browser targets by default
        inlineSources = this.options.mode === 'production';
      }
    }

    let mapFilename = filePath + '.map';
    return map.stringify({
      file: path.basename(mapFilename),
      rootDir: this.options.projectRoot,
      sourceRoot: !inlineSources
        ? url.format(url.parse(sourceRoot + '/'))
        : undefined,
      inlineSources,
      inlineMap:
        bundle.isInline ||
        (bundle.target.sourceMap && bundle.target.sourceMap.inline)
    });
  }

  async writeToCache(cacheKey: string, contents: Blob, map: ?Blob) {
    let contentKey = md5FromString(`${cacheKey}:content`);

    await this.options.cache.setStream(contentKey, blobToStream(contents));

    if (map != null) {
      let mapKey = md5FromString(`${cacheKey}:map`);
      await this.options.cache.setStream(mapKey, blobToStream(map));
    }
  }
}

/*
 * Build a mapping from async, url dependency ids to web-friendly relative paths
 * to their bundles. These will be relative to the current bundle if `publicUrl`
 * is not provided. If `publicUrl` is provided, the paths will be joined to it.
 *
 * These are used to translate any placeholder dependency ids written during
 * transformation back to a path that can be loaded in a browser (such as
 * in a "raw" loader or any transformed dependencies referred to by url).
 */
function generateDepToBundlePath(
  bundle: InternalBundle,
  bundleGraph: InternalBundleGraph
): Map<string, FilePath> {
  let depToBundlePath: Map<string, FilePath> = new Map();
  bundleGraph.traverseBundle(bundle, node => {
    if (node.type !== 'dependency') {
      return;
    }

    let dep = node.value;
    if (!dep.isURL || !dep.isAsync) {
      return;
    }

    let [bundleGroupNode] = bundleGraph._graph.getNodesConnectedFrom(node);
    invariant(bundleGroupNode && bundleGroupNode.type === 'bundle_group');

    let [entryBundleNode] = bundleGraph._graph.getNodesConnectedFrom(
      bundleGroupNode,
      'bundle'
    );
    invariant(entryBundleNode && entryBundleNode.type === 'bundle');

    let entryBundle = entryBundleNode.value;
    depToBundlePath.set(
      dep.id,
      urlJoin(
        nullthrows(entryBundle.target).publicUrl ?? '/',
        nullthrows(entryBundle.name)
      )
    );
  });

  return depToBundlePath;
}

// replace references to url dependencies with relative paths to their
// corresponding bundles.
// TODO: This likely alters the length of the column in the source text.
//       Update any sourcemaps accordingly.
function replaceReferences(
  code: string,
  depToBundlePath: Map<string, FilePath>
): string {
  let output = code;
  for (let [depId, replacement] of depToBundlePath) {
    let split = output.split(depId);
    if (split.length > 1) {
      // the dependency id was found in the text. replace it.
      output = split.join(replacement);
    }
  }

  return output;
}
