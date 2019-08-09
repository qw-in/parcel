// @flow

import type {ConfigRequest, ParcelOptions} from './types';
import type ParcelConfig from './ParcelConfig';

import nullthrows from 'nullthrows';
import {md5FromString} from '@parcel/utils';

import InternalConfig from './Config';
import Config from './public/Config';
import loadParcelConfig from './loadParcelConfig';
import loadPlugin from './loadParcelPlugin';

export default class ConfigLoader {
  options: ParcelOptions;
  parcelConfig: ParcelConfig;

  constructor(options: ParcelOptions) {
    this.options = options;
  }

  load(configRequest: ConfigRequest) {
    if (!configRequest.plugin) {
      return this.loadParcelConfig(configRequest);
    }

    return this.loadPluginConfig(configRequest);
  }

  async loadParcelConfig(configRequest: ConfigRequest) {
    let {filePath, env} = configRequest;
    let internalConfig = new InternalConfig({
      searchPath: filePath,
      env,
      options: this.options
    });
    let config = new Config(internalConfig);

    let {config: parcelConfig, extendedFiles} = nullthrows(
      await loadParcelConfig(filePath, this.options)
    );

    config.setResolvedPath(parcelConfig.filePath);
    config.setResult(parcelConfig);
    this.parcelConfig = parcelConfig;

    let devDeps = [];
    switch (configRequest.meta.actionType) {
      case 'transformation':
        devDeps = parcelConfig.getTransformerNames(filePath);
        break;
      case 'validation':
        devDeps = parcelConfig.getValidatorNames(filePath);
        break;
      case 'dependency':
        devDeps = parcelConfig.getResolverNames();
        break;
    }
    devDeps.forEach(devDep => config.addDevDependency(devDep));

    config.setResultHash(md5FromString(JSON.stringify(devDeps)));

    config.setWatchGlob('**/.parcelrc');

    // TODO: if extended config comes from a package, yarn.lock change should invalidate config request
    for (let extendedFile of extendedFiles) {
      config.addIncludedFile(extendedFile);
    }

    return internalConfig;
  }

  async loadPluginConfig({
    plugin,
    env,
    filePath,
    meta: {parcelConfigPath}
  }: ConfigRequest) {
    let internalConfig = new InternalConfig({
      searchPath: filePath,
      env,
      options: this.options
    });
    let config = new Config(internalConfig);
    plugin = await loadPlugin(nullthrows(plugin), parcelConfigPath);

    plugin.loadConfig &&
      (await plugin.loadConfig({config, options: this.options}));

    return internalConfig;
  }
}