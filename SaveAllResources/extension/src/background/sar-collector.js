// Adapter that runs Save All Resources' own collection, de-duplication and zip packaging code
// (imported unmodified from the recovered 2.0.6 sources, see vendor/) against DevTools-protocol
// data obtained through chrome.debugger instead of the chrome.devtools.* panel APIs.
//
// Upstream panel                                   | This adapter
// -------------------------------------------------|--------------------------------------------------
// chrome.devtools.inspectedWindow.getResources()   | Page.getResourceTree + Page.getResourceContent
// chrome.devtools.network.onRequestFinished (HAR)  | Network.* events + Network.getResponseBody
// processStaticResourceToStore / processNetwork…   | same functions (upstream utils/resource.js)
// React useReducer store                           | same reducers (upstream store/reducers.js)
// resolveDuplicatedResources / addItemsToZipWriter | same functions (upstream utils/file.js)
// downloadCompleteZip (<a download>)               | Blob returned to the job runner for upload

import * as zip from '@zip.js/zip.js';
import { processNetworkResourceToStore, processStaticResourceToStore } from 'devtoolApp/utils/resource';
import { resolveDuplicatedResources, addItemsToZipWriter } from 'devtoolApp/utils/file';
import { appReducers, appInitialState } from 'devtoolApp/store/reducers';
import { addQueryDiscriminator } from '../shared/url-scope.js';

// Service workers cannot spawn web workers.
zip.configure({ useWebWorkers: false });

const SKIP_URL = /^(data:|blob:|debugger:|chrome-extension:|chrome:|ws:|wss:|about:)/;

/** A tiny store with the same reducer + thunk semantics as the panel's useStoreConfigure(). */
export function createSarStore() {
  let state = appInitialState;
  let adds = 0;
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, () => state);
    if (action?.type?.endsWith('_RESOURCE_ACTION_ADD')) adds++;
    state = appReducers(state, action);
    return action;
  };
  return {
    dispatch,
    getState: () => state,
    addCount: () => adds,
  };
}

/** Wrap a CDP frame-tree resource as a chrome.devtools.inspectedWindow Resource-like object. */
export function toDevtoolsResource(cdp, frameId, r) {
  return {
    url: r.url,
    type: r.type?.toLowerCase(),
    getContent(callback) {
      cdp
        .send('Page.getResourceContent', { frameId, url: r.url })
        .then((res) => callback(res.content, res.base64Encoded ? 'base64' : undefined))
        .catch(() => callback(null, undefined));
    },
  };
}

/** Wrap a recorded network exchange as a HAR entry like chrome.devtools.network delivers. */
export function toHarEntry(cdp, rec) {
  return {
    request: { url: rec.url, method: rec.method },
    response: {
      status: rec.status,
      content: { mimeType: rec.mimeType },
      headers: rec.contentType ? [{ name: 'content-type', value: rec.contentType }] : [],
    },
    getContent(callback) {
      cdp
        .send('Network.getResponseBody', { requestId: rec.requestId })
        .then((res) => callback(res.body, res.base64Encoded ? 'base64' : undefined))
        .catch(() => callback(null, undefined));
    },
  };
}

function flattenFrameTree(tree, out = []) {
  if (!tree) return out;
  for (const r of tree.resources || []) out.push({ frameId: tree.frame.id, resource: r });
  out.push({ frameId: tree.frame.id, resource: { url: tree.frame.url, type: 'Document', mimeType: tree.frame.mimeType } });
  for (const child of tree.childFrames || []) flattenFrameTree(child, out);
  return out;
}

/**
 * Collect resources for the currently loaded page with Save All Resources' logic.
 * @param cdp CdpSession attached to the tab
 * @param networkRecords completed network exchanges (from NetworkRecorder)
 * @param filter (url, meta) => { include: boolean, reason?: string } — size / type limits
 */
export async function collectWithSar(cdp, networkRecords, filter, { timeoutMs = 60_000 } = {}) {
  const store = createSarStore();
  const skipped = [];
  let submitted = 0;

  for (const rec of networkRecords) {
    if (SKIP_URL.test(rec.url)) continue;
    const verdict = filter(rec.url, rec);
    if (!verdict.include) {
      skipped.push({ url: rec.url, reason: verdict.reason });
      continue;
    }
    submitted++;
    processNetworkResourceToStore(store.dispatch, toHarEntry(cdp, rec));
  }

  const tree = await cdp.send('Page.getResourceTree');
  for (const { frameId, resource } of flattenFrameTree(tree.frameTree)) {
    if (!resource.url || SKIP_URL.test(resource.url)) continue;
    const verdict = filter(resource.url, { type: resource.type, mimeType: resource.mimeType, size: resource.contentSize, failed: resource.failed });
    if (!verdict.include) {
      skipped.push({ url: resource.url, reason: verdict.reason });
      continue;
    }
    submitted++;
    processStaticResourceToStore(store.dispatch, toDevtoolsResource(cdp, frameId, resource));
  }

  // Upstream processors dispatch exactly one ADD per submitted resource once content is resolved.
  const deadline = Date.now() + timeoutMs;
  while (store.addCount() < submitted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const timedOut = store.addCount() < submitted;

  const { networkResource, staticResource } = store.getState();
  const merged = [...(networkResource || []), ...(staticResource || [])].map((item) => ({
    ...item,
    // Collision safety: upstream resolveURLToPath drops the query string.
    saveAs: item.saveAs && { ...item.saveAs, path: addQueryDiscriminator(item.saveAs.path, item.url) },
  }));
  const toDownload = resolveDuplicatedResources(merged);
  return { toDownload, skipped, timedOut, pendingResources: submitted - store.addCount() };
}

/**
 * Package resources using the upstream zip writer, then append capture metadata entries.
 * Returns a Blob (application/zip) instead of triggering a browser download.
 */
export function packageWithSar(toDownload, options, extraEntries = []) {
  return new Promise((resolve, reject) => {
    const blobWriter = new zip.BlobWriter('application/zip');
    const zipWriter = new zip.ZipWriter(blobWriter);
    const written = [];
    addItemsToZipWriter(
      zipWriter,
      toDownload,
      { ignoreNoContentFile: !!options.ignoreNoContentFile, beautifyFile: !!options.beautifyFile },
      (item, added) => written.push({ url: item.url, path: item.saveAs?.path, added, hasContent: !!item.content, failed: !!item.failed }),
      async () => {
        try {
          for (const entry of extraEntries) {
            const reader = entry.blob ? new zip.BlobReader(entry.blob) : new zip.TextReader(entry.text);
            await zipWriter.add(entry.path, reader);
          }
          await zipWriter.close();
          resolve({ blob: await blobWriter.getData(), written });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}
