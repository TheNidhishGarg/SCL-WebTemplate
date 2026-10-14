// The path rule Save All Resources uses when it writes a resource into its ZIP
// (resolveURLToPath in vendor/save-all-resources-2.0.6/recovered-src/src/devtoolApp/utils/url.js),
// ported without the data-URI branch. A download made with the Web Store build keeps no URL list,
// so this is how an imported download's files are matched back to the URLs its pages reference.

const TYPE_EXTENSIONS = ['html', 'css', 'js', 'json', 'jpg', 'gif', 'png', 'webp'];

/**
 * ZIP path for an absolute http(s) URL, without the extension SAR appends to extension-less names
 * (that one depends on the response type, which a download does not record).
 * @returns {{ path: string, hasExtension: boolean } | null}
 */
export function sarBasePath(url) {
  const i = url.search(/:\/\//);
  if (i === -1 || i >= 10) return null;
  let filepath = url.split('://')[0].includes('http') ? url.split('://')[1].split('?')[0] : url.replace('://', '---').split('?')[0];
  filepath = filepath.split('#')[0];
  if (filepath.endsWith('/')) filepath += 'index.html';
  let filename = filepath.slice(filepath.lastIndexOf('/') + 1).split(';')[0];
  filepath = filepath.slice(0, filepath.lastIndexOf('/') + 1) + filename;
  const hasExtension = filename.includes('.');
  filepath = clean(filepath);
  return { path: filepath, hasExtension };
}

/** Every ZIP path SAR may have used for this URL, most likely first. */
export function sarPathCandidates(url) {
  const base = sarBasePath(url);
  if (!base) return [];
  if (base.hasExtension) return [base.path];
  // SAR adds the extension before cleaning; cleaning never touches a trailing ".ext", so appending after is equivalent.
  return TYPE_EXTENSIONS.map((ext) => `${base.path}.${ext}`);
}

function clean(p) {
  let filepath = p
    .replace(/:|\\|=|\*|\.$|"|'|\?|~|\||<|>/g, '')
    .replace(/\/\//g, '/')
    .replace(/(\s|\.)\//g, '/')
    .replace(/\/(\s|\.)/g, '/');
  if (filepath.includes('%')) {
    try {
      filepath = decodeURIComponent(filepath);
    } catch {
      /* SAR keeps the encoded form when decoding fails */
    }
  }
  while (filepath.includes('//')) filepath = filepath.replace('//', '/');
  if (filepath.startsWith('/')) filepath = filepath.slice(1);
  return filepath;
}
