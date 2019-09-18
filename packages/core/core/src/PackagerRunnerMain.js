// @flow

import type {FilePath} from '@parcel/types';
import type {Bundle as InternalBundle, ParcelOptions} from './types';
import type ParcelConfig from './ParcelConfig';
import type InternalBundleGraph from './BundleGraph';

import {md5FromObject, md5FromString} from '@parcel/utils';
import {Readable} from 'stream';
import nullthrows from 'nullthrows';

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

  constructor({config, farm, options}: Opts) {
    this.config = config;
    this.options = options;
    this.pluginOptions = new PluginOptions(this.options);

    this.writeBundleFromWorker = farm.createHandle('runPackage');
  }

  // : {bundle: InternalBundle,
  //   bundleGraph: InternalBundleGraph,
  //   cacheKey: string}
  async writeBundleFromCache({bundle, bundleGraph, cacheKey}) {
    if (this.options.disableCache) {
      return;
    }

    let cacheResult = await this.readFromCache(cacheKey);
    if (cacheResult == null) {
      return;
    }

    let {contents, map} = cacheResult;
    let {size} = await writeBundle({
      bundle,
      bundleGraph,
      contents,
      map,
      options: this.options
    });

    return {size};
  }

  async writeBundle(bundle: InternalBundle, bundleGraph: InternalBundleGraph) {
    let start = Date.now();

    let cacheKey = await this.getCacheKey(bundle, bundleGraph);
    let {size} =
      (await this.writeBundleFromCache({bundle, bundleGraph, cacheKey})) ||
      (await this.writeBundleFromWorker({
        bundle,
        bundleGraph,
        cacheKey,
        options: this.options,
        config: this.config
      }));

    return {
      time: Date.now() - start,
      size
    };
  }

  getCacheKey(
    bundle: InternalBundle,
    bundleGraph: InternalBundleGraph
  ): string {
    let filePath = nullthrows(bundle.filePath);
    let packager = this.config.getPackagerName(filePath);
    let optimizers = this.config.getOptimizerNames(filePath);
    let deps = Promise.all(
      [packager, ...optimizers].map(async pkg => {
        let {pkg: resolvedPkg} = await this.options.packageManager.resolve(
          `${pkg}/package.json`,
          `${this.config.filePath}/index` // TODO: is this right?
        );

        let version = nullthrows(resolvedPkg).version;
        return [pkg, version];
      })
    );

    // TODO: add third party configs to the cache key
    let {minify, scopeHoist, sourceMaps} = this.options;
    return md5FromObject({
      deps,
      opts: {minify, scopeHoist, sourceMaps},
      hash: bundleGraph.getHash(bundle)
    });
  }

  async readFromCache(
    cacheKey: string
  ): Promise<?{|
    contents: Readable,
    map: ?Readable
  |}> {
    let contentKey = md5FromString(`${cacheKey}:content`);
    let mapKey = md5FromString(`${cacheKey}:map`);

    let contentExists = await this.options.cache.blobExists(contentKey);
    if (!contentExists) {
      return null;
    }

    let mapExists = await this.options.cache.blobExists(mapKey);

    return {
      contents: this.options.cache.getStream(contentKey),
      map: mapExists ? this.options.cache.getStream(mapKey) : null
    };
  }
}
