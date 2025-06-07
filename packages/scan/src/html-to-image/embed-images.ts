import { Options } from './types'
import { embedResources } from './embed-resources'
import { toArray, isInstanceOfElement } from './util'
import { isDataUrl, resourceToDataURL } from './dataurl'
import { getMimeType } from './mimes'

async function embedProp(
  propName: string,
  node: HTMLElement,
  options: Options,
) {
  const propValue = node.style?.getPropertyValue(propName)
  if (propValue) {
    const cssString = await embedResources(propValue, null, options)
    node.style.setProperty(
      propName,
      cssString,
      node.style.getPropertyPriority(propName),
    )
    return true
  }
  return false
}

async function embedBackground<T extends HTMLElement>(
  clonedNode: T,
  options: Options,
) {
  ;(await embedProp('background', clonedNode, options)) ||
    (await embedProp('background-image', clonedNode, options))
  ;(await embedProp('mask', clonedNode, options)) ||
    (await embedProp('-webkit-mask', clonedNode, options)) ||
    (await embedProp('mask-image', clonedNode, options)) ||
    (await embedProp('-webkit-mask-image', clonedNode, options))
}

async function embedImageNode<T extends HTMLElement | SVGImageElement>(
  clonedNode: T,
  options: Options,
) {
  const isImageElement = isInstanceOfElement(clonedNode, HTMLImageElement);

  if (
    !(isImageElement && !isDataUrl(clonedNode.src)) &&
    !(
      isInstanceOfElement(clonedNode, SVGImageElement) &&
      !isDataUrl(clonedNode.href.baseVal)
    )
  ) {
    return;
  }

  const url = isImageElement ? clonedNode.src : clonedNode.href.baseVal;

  // resourceToDataURL handles initial fetch errors and returns a fallback
  const dataURL = await resourceToDataURL(url, getMimeType(url), options);

  // Wait for the browser to process the assigned dataURL (or fallback)
  await new Promise((resolve, reject) => { // Keep reject for custom handler flexibility
    clonedNode.onload = resolve;
    clonedNode.onerror = options.onImageErrorHandler
      ? (...attributes) => { // If user provided a handler
          try {
            // Let the custom handler decide whether to resolve or reject
             Promise.resolve(options.onImageErrorHandler!(...attributes))
                .then(resolve) // Resolve if the handler resolves/returns non-promise
                .catch(reject); // Reject if the handler throws/rejects
          } catch (error) {
            console.error("[html-to-image] Error in custom onImageErrorHandler:", error);
            // If the handler itself throws, reject to signal the handler failed
            reject(error);
          }
        }
      : () => { // <-- Default case: Changed from reject to resolve
          console.warn(`[html-to-image] Failed to load image data URL (or placeholder) for: ${url}. Proceeding anyway.`);
          resolve(undefined); // Resolve to allow the process to continue
        };

    // Assign the dataURL (could be original or fallback)
    const image = clonedNode as HTMLImageElement;
    if (image.decode) {
       // Use decode for potentially better performance/control, but still resolve on error
       image.decode().then(resolve).catch(() => {
           console.warn(`[html-to-image] Image decode() failed for: ${url}. Proceeding anyway.`);
           resolve(undefined); // Resolve even if decode fails
       });
    }

    if (image.loading === 'lazy') {
      image.loading = 'eager';
    }

    if (isImageElement) {
      clonedNode.srcset = ''; // Clear srcset as we are using src
      clonedNode.src = dataURL;
    } else {
      clonedNode.href.baseVal = dataURL;
    }

    // Safety timeout in case load/error/decode events never fire
    const safetyTimeout = setTimeout(() => {
        console.warn(`[html-to-image] Image load timeout for ${url}. Proceeding.`);
        // Ensure listeners are removed before resolving to avoid potential double resolves
        clonedNode.removeEventListener('load', clearSafetyTimeout);
        clonedNode.removeEventListener('error', clearSafetyTimeout);
        resolve(undefined);
    }, 5000); // 5-second timeout

    const clearSafetyTimeout = () => clearTimeout(safetyTimeout);
    clonedNode.addEventListener('load', clearSafetyTimeout, { once: true });
    clonedNode.addEventListener('error', clearSafetyTimeout, { once: true });
    // No need to add listener for decode, its promise handles completion/error

  }); // End of Promise
} // End of embedImageNode

async function embedChildren<T extends HTMLElement>(
  clonedNode: T,
  options: Options,
) {
  const children = toArray<HTMLElement>(clonedNode.childNodes)
  const deferreds = children.map((child) => embedImages(child, options))
  await Promise.all(deferreds).then(() => clonedNode)
}

export async function embedImages<T extends HTMLElement>(
  clonedNode: T,
  options: Options,
) {
  if (isInstanceOfElement(clonedNode, Element)) {
    await embedBackground(clonedNode, options)
    await embedImageNode(clonedNode, options)
    await embedChildren(clonedNode, options)
  }
}
