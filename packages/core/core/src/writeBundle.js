// @flow
import nullthrows from 'nullthrows';
import path from 'path';
import {Readable} from 'stream';

import type {FileSystem, FileOptions} from '@parcel/fs';
import type {FilePath} from '@parcel/types';

import {NamedBundle} from './public/Bundle';

export default async function writeBundle({
  bundle,
  bundleGraph,
  contents,
  map,
  options
}) {
  let {inputFS, outputFS} = options;
  let filePath = nullthrows(bundle.filePath);
  let dir = path.dirname(filePath);
  await outputFS.mkdirp(dir); // ? Got rid of dist exists, is this an expensive operation

  // Use the file mode from the entry asset as the file mode for the bundle.
  // Don't do this for browser builds, as the executable bit in particular is unnecessary.
  let publicBundle = new NamedBundle(bundle, bundleGraph, options);
  let writeOptions = publicBundle.env.isBrowser()
    ? undefined
    : {
        mode: (await inputFS.stat(
          nullthrows(publicBundle.getMainEntry()).filePath
        )).mode
      };

  let size;
  if (contents instanceof Readable) {
    size = await writeFileStream(outputFS, filePath, contents, writeOptions);
  } else {
    await outputFS.writeFile(filePath, contents, writeOptions);
    size = contents.length;
  }

  if (map != null) {
    if (map instanceof Readable) {
      await writeFileStream(outputFS, filePath + '.map', map);
    } else {
      await outputFS.writeFile(filePath + '.map', map);
    }
  }

  return {size};
}

function writeFileStream(
  fs: FileSystem,
  filePath: FilePath,
  stream: Readable,
  options: ?FileOptions
): Promise<number> {
  return new Promise((resolve, reject) => {
    let fsStream = fs.createWriteStream(filePath, options);
    stream
      .pipe(fsStream)
      // $FlowFixMe
      .on('finish', () => resolve(fsStream.bytesWritten))
      .on('error', reject);
  });
}
