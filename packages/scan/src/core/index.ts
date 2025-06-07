import { type Signal, signal } from '@preact/signals';
import {
  type Fiber,
  type FiberRoot,
  detectReactBuildType,
  getRDTHook,
  getType,
  isInstrumentationActive,
} from 'bippy';
import type { ComponentType } from 'preact';
import type { ReactNode } from 'preact/compat';
import type { RenderData } from 'src/core/utils';
import { initReactScanInstrumentation } from 'src/new-outlines';
import styles from '~web/assets/css/styles.css';
import { createToolbar } from '~web/toolbar';
import { IS_CLIENT } from '~web/utils/constants';
import { readLocalStorage, saveLocalStorage } from '~web/utils/helpers';
import type { Outline } from '~web/utils/outline';
import type { States } from '~web/views/inspector/utils';
import type {
  ChangeReason,
  Render,
  createInstrumentation,
} from './instrumentation';
import type { InternalInteraction } from './monitor/types';
import type { getSession } from './monitor/utils';
import { startTimingTracking } from './notifications/event-tracking';
import { createHighlightCanvas } from './notifications/outline-overlay';
import packageJson from '../../package.json';
// --- Import html-to-image ---
import * as htmlToImage from '../html-to-image';
import type { Options as HtmlToImageOptions } from '../html-to-image';
import { getPixelRatio } from '../html-to-image/util';
// import { IframeResizer } from './iframe-resizer';


const searchParams = new URLSearchParams(window.location.search);
let iframeId = '';
if (searchParams.has('__covolute_iframeId__')) {
  iframeId = searchParams.get('__covolute_iframeId__') ?? '';
  searchParams.delete('__covolute_iframeId__');
  window.history.replaceState(null, '', window.location.pathname + (searchParams.toString() ? '?' + searchParams.toString() : '') + window.location.hash);
}


const PARENT_ORIGIN = '*'; // WARNING: Use specific origin in production!
// --- END: Ensure necessary imports ---

// --- START: Helper function to load image data URLs ---
const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (err) => {
          console.error(`[React Scan Iframe] Failed to load image data URL: ${url.substring(0,100)}...`);
          reject(err);
      };
      img.src = url;
  });
};
// --- END: Helper function ---


// --- START: Helper function to find visible fixed/sticky elements ---
interface FixedStickyElementInfo {
  element: HTMLElement;
  rect: DOMRect; // Viewport relative position
}

const findVisibleFixedStickyElements = (): FixedStickyElementInfo[] => {
  const elements: FixedStickyElementInfo[] = [];
  // Query all elements - consider performance implications if the DOM is huge.
  // Optimizations could involve querying only elements potentially having fixed/sticky styles
  // or listening to specific mutation observers, but querySelectorAll is simpler for now.
  const allElementsNodeList = document.querySelectorAll('*');
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  // Correct: Convert NodeList to Array before iterating with for...of
  const allElementsArray = Array.from(allElementsNodeList);

  for (const element of allElementsArray) { // Iterate over the converted array
      if (!(element instanceof HTMLElement)) continue;

      const style = window.getComputedStyle(element);
      const position = style.position;
      const isFixedOrSticky = position === 'fixed' || position === 'sticky';

      if (!isFixedOrSticky) continue;

      const rect = element.getBoundingClientRect();

      // Basic visibility checks
      const isVisible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0;

      if (!isVisible) continue;

      // Check if it overlaps with the viewport
      const isInViewport =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < viewportHeight &&
          rect.left < viewportWidth;

      if (isInViewport) {
          elements.push({ element, rect });
      }
  }
  return elements;
};
// --- END: Helper function ---


// --- Global State and Types (Original - unchanged) ---
let rootContainer: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;

interface RootContainer {
  rootContainer: HTMLDivElement;
  shadowRoot: ShadowRoot;
}

const initRootContainer = (): RootContainer => {
  if (rootContainer && shadowRoot) {
    return { rootContainer, shadowRoot };
  }

  rootContainer = document.createElement('div');
  rootContainer.id = 'react-scan-root'; // Keep this ID for potential filtering

  shadowRoot = rootContainer.attachShadow({ mode: 'open' });

  rootContainer.style.setProperty('display', 'none', 'important');

  const cssStyles = document.createElement('style');
  cssStyles.textContent = styles;

  shadowRoot.appendChild(cssStyles);

  document.documentElement.appendChild(rootContainer);

  return { rootContainer, shadowRoot };
};

export interface Options {
  enabled?: boolean;
  dangerouslyForceRunInProduction?: boolean;
  log?: boolean;
  showToolbar?: boolean;
  animationSpeed?: 'slow' | 'fast' | 'off';
  trackUnnecessaryRenders?: boolean;
  showFPS?: boolean;
  showNotificationCount?: boolean;
  _debug?: 'verbose' | false;
  onCommitStart?: () => void;
  onRender?: (fiber: Fiber, renders: Array<Render>) => void;
  onCommitFinish?: () => void;
  onPaintStart?: (outlines: Array<Outline>) => void;
  onPaintFinish?: (outlines: Array<Outline>) => void;
}

export type MonitoringOptions = Pick<
  Options,
  | 'enabled'
  | 'onCommitStart'
  | 'onCommitFinish'
  | 'onPaintStart'
  | 'onPaintFinish'
  | 'onRender'
>;

interface Monitor {
  pendingRequests: number;
  interactions: Array<InternalInteraction>;
  session: ReturnType<typeof getSession>;
  url: string | null;
  route: string | null;
  apiKey: string | null;
  commit: string | null;
  branch: string | null;
}

export interface StoreType {
  inspectState: Signal<States>;
  wasDetailsOpen: Signal<boolean>;
  lastReportTime: Signal<number>;
  isInIframe: Signal<boolean>;
  monitor: Signal<Monitor | null>;
  fiberRoots: WeakSet<Fiber>; // Changed from Set to WeakSet
  reportData: Map<number, RenderData>;
  legacyReportData: Map<string, RenderData>; // Consider removing if legacy not needed
  changesListeners: Map<number, Array<ChangesListener>>;
  interactionListeningForRenders:
    | ((fiber: Fiber, renders: Array<Render>) => void)
    | null;
}

export type OutlineKey = `${string}-${string}`;

export interface Internals {
  instrumentation: ReturnType<typeof createInstrumentation> | null;
  componentAllowList: WeakMap<ComponentType<unknown>, Options> | null;
  options: Signal<Options>;
  scheduledOutlines: Map<Fiber, Outline>;
  activeOutlines: Map<OutlineKey, Outline>;
  onRender: ((fiber: Fiber, renders: Array<Render>) => void) | null;
  Store: StoreType;
  version: string;
}

export type FunctionalComponentStateChange = {
  type: ChangeReason.FunctionalState;
  value: unknown;
  prevValue?: unknown;
  count?: number | undefined;
  name: string;
};
export type ClassComponentStateChange = {
  type: ChangeReason.ClassState;
  value: unknown;
  prevValue?: unknown;
  count?: number | undefined;
  name: 'state';
};

export type StateChange =
  | FunctionalComponentStateChange
  | ClassComponentStateChange;
export type PropsChange = {
  type: ChangeReason.Props;
  name: string;
  value: unknown;
  prevValue?: unknown;
  count?: number | undefined;
};
export type ContextChange = {
  type: ChangeReason.Context;
  name: string;
  value: unknown;
  prevValue?: unknown;
  count?: number | undefined;
  contextType: number;
};

export type Change = StateChange | PropsChange | ContextChange;

export type ChangesPayload = {
  propsChanges: Array<PropsChange>;
  stateChanges: Array<
    FunctionalComponentStateChange | ClassComponentStateChange
  >;
  contextChanges: Array<ContextChange>;
};
export type ChangesListener = (changes: ChangesPayload) => void;

export const Store: StoreType = {
  wasDetailsOpen: signal(true),
  isInIframe: signal(IS_CLIENT && window.self !== window.top),
  inspectState: signal<States>({
    kind: 'uninitialized',
  }),
  monitor: signal<Monitor | null>(null),
  fiberRoots: new WeakSet<Fiber>(), // Use WeakSet
  reportData: new Map<number, RenderData>(),
  legacyReportData: new Map<string, RenderData>(),
  lastReportTime: signal(0),
  interactionListeningForRenders: null,
  changesListeners: new Map(),
};

export const ReactScanInternals: Internals = {
  instrumentation: null,
  componentAllowList: null,
  options: signal({
    enabled: true,
    log: false,
    showToolbar: true,
    animationSpeed: 'fast',
    dangerouslyForceRunInProduction: false,
    showFPS: true,
    showNotificationCount: true,
  }),
  onRender: null,
  scheduledOutlines: new Map(),
  activeOutlines: new Map(),
  Store,
  version: packageJson.version,
};

if (IS_CLIENT && window.__REACT_SCAN_EXTENSION__) {
  window.__REACT_SCAN_VERSION__ = ReactScanInternals.version;
}

export type LocalStorageOptions = Omit<
  Options,
  | 'onCommitStart'
  | 'onRender'
  | 'onCommitFinish'
  | 'onPaintStart'
  | 'onPaintFinish'
>;

// --- START: MODIFIED CODE for postMessage Communication ---

/**
 * Scans the iframe's DOM for all elements with the 'data-sourcefile' attribute
 * and returns a list of unique file paths found.
 * @returns {string[]} An array of unique source file paths.
 */
const findAllSourceFiles = (): string[] => {
    if (!IS_CLIENT) return [];
    const fileSet = new Set<string>();
    const elementsWithSourceFile = document.querySelectorAll('[data-sourcefile]');
    elementsWithSourceFile.forEach((element) => {
        const sourceFile = (element as HTMLElement).dataset.sourcefile;
        if (sourceFile) {
            fileSet.add(sourceFile);
        }
    });
    return Array.from(fileSet);
};

/**
 * Handles dragenter events within the iframe and notifies the parent.
 * @param {DragEvent} event - The drag event object.
 */
const handleDragEnter = (event: DragEvent) => {
  // Optional: Add checks here if you only want to notify for specific targets
  // console.log('[React Scan Iframe] Drag entered iframe.');
  try {
      window.parent.postMessage({
          type: 'IFRAME_DRAG_ENTER',
          iframeId,
          payload: {
              // Optionally include minimal data about the target if needed
              // targetTagName: (event.target as Element)?.tagName
          }
      }, PARENT_ORIGIN);
  } catch (error) {
      console.error("[React Scan Iframe] Error posting DRAG_ENTER message:", error);
  }
};

/**
* Handles keydown and keyup events within the iframe and notifies the parent.
* @param {KeyboardEvent} event - The keyboard event object.
*/
const handleKeyEvent = (event: KeyboardEvent) => {
  // Avoid sending messages if the event originates from within the toolbar itself (e.g., input fields)
  const path = event.composedPath();
  if (path.some(el => el instanceof Element && (el.id === 'react-scan-toolbar-root' || el.id === 'react-scan-root'))) {
      return;
  }

  // console.log(`[React Scan Iframe] Key event: ${event.type}, Key: ${event.key}`);
  let messageType: string;
  switch (event.type) {
      case 'keydown':
          messageType = 'IFRAME_KEY_DOWN';
          break;
      case 'keyup':
          messageType = 'IFRAME_KEY_UP';
          break;
      // Add 'keypress' if needed, though keydown/up are generally preferred
      // case 'keypress':
      //     messageType = 'IFRAME_KEY_PRESS';
      //     break;
      default:
          return; // Ignore other event types
  }

  try {
      window.parent.postMessage({
          type: messageType,
          iframeId,
          payload: {
              key: event.key,
              code: event.code,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              repeat: event.repeat,
              location: event.location,
              // targetTagName: (event.target as Element)?.tagName // Optionally include target info
          }
      }, PARENT_ORIGIN);
  } catch (error) {
      console.error(`[React Scan Iframe] Error posting ${messageType} message:`, error);
  }
};

/**
 * Handles incoming messages from the parent window.
 * Handles requests for file lists, iframe URL, and page screenshots.
 * @param {MessageEvent} event - The message event object.
 */
const handleParentMessage = async (event: MessageEvent) => {
    if (PARENT_ORIGIN !== '*' && event.origin !== PARENT_ORIGIN) {
        console.warn(`[React Scan Iframe] Ignoring message from untrusted origin: ${event.origin}`);
        return;
    }

    const request = event.data;

    if (!request || !request.type) {
        console.warn('[React Scan Iframe] Received invalid message:', event.data);
        return;
    }

    // --- Handle File List Request ---
    if (request.type === 'REQUEST_FILE_LIST') {
        console.log('[React Scan Iframe] Received REQUEST_FILE_LIST from parent.');
        const files = findAllSourceFiles();
        window.parent.postMessage({
            type: 'FILE_LIST_RESPONSE',
            iframeId,
            payload: { files: files },
            requestId: request.requestId,
        }, PARENT_ORIGIN);
        console.log('[React Scan Iframe] Sent FILE_LIST_RESPONSE to parent:', files);
    }
    // --- Handle URL Request ---
    else if (request.type === 'REQUEST_IFRAME_URL') {
        console.log('[React Scan Iframe] Received REQUEST_IFRAME_URL from parent.');
        const currentUrl = window.location.href;
        window.parent.postMessage({
            type: 'IFRAME_URL_RESPONSE',
            iframeId,
            payload: { url: currentUrl },
            requestId: request.requestId,
        }, PARENT_ORIGIN);
        console.log('[React Scan Iframe] Sent IFRAME_URL_RESPONSE to parent:', currentUrl);
    }
    // --- START: Handle Screenshot Request (Adjust Fixed Elements & Crop) ---
    else if (request.type === 'REQUEST_PAGE_SCREENSHOT') {
      // console.log('[React Scan Iframe] Received REQUEST_PAGE_SCREENSHOT (Visible + Fixed/Sticky + DPR) from parent.');
      try {
          const body = document.body;
          const documentElement = document.documentElement;

          // 1. Get viewport dimensions, scroll offsets, and pixel ratio
          const viewportWidth = documentElement.clientWidth;
          const viewportHeight = documentElement.clientHeight;
          const scrollLeft = documentElement.scrollLeft || body.scrollLeft;
          const scrollTop = documentElement.scrollTop || body.scrollTop;
          const pixelRatio = getPixelRatio(); // Get device pixel ratio

          // console.log(`[React Scan Iframe] Capture details: VpW=${viewportWidth}, VpH=${viewportHeight}, ScrollX=${scrollLeft}, ScrollY=${scrollTop}, DPR=${pixelRatio}`);

          // 2. Capture the main scrollable content (background layer) with pixel ratio
          const mainContentOptions: HtmlToImageOptions = {
              width: viewportWidth,
              height: viewportHeight,
              pixelRatio: pixelRatio, // Apply pixel ratio
              backgroundColor: '#ffffff',
              style: {
                  transform: `translate(-${scrollLeft}px, -${scrollTop}px)`,
                  width: `${Math.max(body.scrollWidth, documentElement.scrollWidth)}px`,
                  height: `${Math.max(body.scrollHeight, documentElement.scrollHeight)}px`,
                  margin: '0', padding: '0',
              },
          };
          const mainContentDataUrl = await htmlToImage.toPng(body, mainContentOptions);

          // 3. Identify visible fixed/sticky elements
          const fixedStickyElements = findVisibleFixedStickyElements();

          // 4. Capture each fixed/sticky element individually with pixel ratio
          const fixedStickyCaptures = await Promise.allSettled(
              fixedStickyElements.map(async ({ element, rect }) => {
                  try {
                      const elementOptions: HtmlToImageOptions = {
                          width: Math.ceil(rect.width),
                          height: Math.ceil(rect.height),
                          pixelRatio: pixelRatio, // Apply pixel ratio
                          backgroundColor: undefined, // Transparent background
                          style: { margin: '0', padding: '0' }
                      };
                      const dataUrl = await htmlToImage.toPng(element, elementOptions);
                      return { element, rect, dataUrl };
                  } catch (captureError) {
                      console.warn(`[React Scan Iframe] Failed to capture fixed/sticky element:`, element, captureError);
                      return null;
                  }
              })
          );

          // 5. Combine captures onto a final canvas (scaled by pixel ratio)
          const finalCanvas = document.createElement('canvas');
          // Set canvas physical dimensions (higher resolution)
          finalCanvas.width = viewportWidth * pixelRatio;
          finalCanvas.height = viewportHeight * pixelRatio;
          const ctx = finalCanvas.getContext('2d');

          if (!ctx) {
              throw new Error("Failed to get 2D context for final canvas");
          }

          // Draw the main content first (drawImage scales based on source image dimensions)
          try {
              const mainImage = await loadImage(mainContentDataUrl);
               // Ensure drawing covers the full scaled canvas
              ctx.drawImage(mainImage, 0, 0, finalCanvas.width, finalCanvas.height);
          } catch (e) {
               console.error("[React Scan Iframe] Failed to load main content image", e);
               ctx.fillStyle = '#cccccc'; // Example fallback
               ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
          }

          // Draw fixed/sticky elements on top, scaling positions and dimensions
          for (const result of fixedStickyCaptures) {
              if (result.status === 'fulfilled' && result.value) {
                  const { rect, dataUrl } = result.value;
                  try {
                      const fixedStickyImage = await loadImage(dataUrl);
                      // Scale draw position and size by pixelRatio
                      ctx.drawImage(
                          fixedStickyImage,
                          rect.left * pixelRatio,    // Scaled X position
                          rect.top * pixelRatio,     // Scaled Y position
                          rect.width * pixelRatio,   // Scaled width
                          rect.height * pixelRatio   // Scaled height
                      );
                  } catch (e) {
                      console.warn(`[React Scan Iframe] Failed to load or draw fixed/sticky image:`, result.value.element, e);
                  }
              }
          }

          // 6. Get final data URL (now high-resolution) and send response
          const finalDataUrl = finalCanvas.toDataURL('image/png');
          window.parent.postMessage({
              type: 'PAGE_SCREENSHOT_RESPONSE',
              iframeId,
              payload: { dataUrl: finalDataUrl },
              requestId: request.requestId,
          }, PARENT_ORIGIN);
          // console.log('[React Scan Iframe] Sent PAGE_SCREENSHOT_RESPONSE (Visible + Fixed/Sticky + DPR) to parent.');

      } catch (error) {
          console.error('[React Scan Iframe] Error capturing composite page screenshot:', error);
          let errorMessage = 'Failed to capture composite page screenshot.';
          if (error instanceof Error) {
              errorMessage += ` Reason: ${error.message}`;
          }
          window.parent.postMessage({
              type: 'PAGE_SCREENSHOT_RESPONSE',
              iframeId,
              error: errorMessage,
              requestId: request.requestId,
          }, PARENT_ORIGIN);
      }
  } else if (request.type === 'SET_THEME') {
    const { theme } = request.payload;
    const classes = document.documentElement.classList;
    classes?.remove('light', 'dark');
    classes?.add(theme);
  }
    // --- END: Handle Screenshot Request (Adjust Fixed Elements & Crop) ---
};


let messageListenerAdded = false;

const addMessageListener = () => {
     if (!IS_CLIENT || messageListenerAdded) {
        return;
    }
    window.addEventListener('message', handleParentMessage);
    messageListenerAdded = true;
    console.log('[React Scan Iframe] Message listener added.');
};

// --- END: MODIFIED CODE for postMessage Communication ---

// --- Original Option Handling, Initialization, Exports (Unchanged) ---
// ... (keep the rest of the file as it was previously, including start(), scan(), setOptions(), etc.) ...

function isOptionKey(key: string): key is keyof Options {
  // Use a more robust check if default options change
  const defaultKeys = Object.keys(ReactScanInternals.options.value);
  return defaultKeys.includes(key);
}


const validateOptions = (options: Partial<Options>): Partial<Options> => {
  const errors: Array<string> = [];
  const validOptions: Partial<Options> = {};

  for (const key in options) {
    if (!isOptionKey(key)) {
        if(ReactScanInternals.options.value._debug) {
           console.warn(`[React Scan] Unknown option provided during validation: "${key}"`);
        }
        continue; // Skip unknown keys strictly
    }


    const value = options[key];
    switch (key) {
      case 'enabled':
      case 'log':
      case 'showToolbar':
      case 'showNotificationCount':
      case 'dangerouslyForceRunInProduction':
      case 'trackUnnecessaryRenders': // Added this
      case 'showFPS':
        if (typeof value !== 'boolean') {
          errors.push(`- ${key} must be a boolean. Got "${value}"`);
        } else {
          validOptions[key] = value;
        }
        break;
      case 'animationSpeed':
        if (!['slow', 'fast', 'off'].includes(value as string)) {
          errors.push(
            `- Invalid animation speed "${value}". Using default "fast"`,
          );
          // Don't set invalid value
        } else {
          validOptions[key] = value as 'slow' | 'fast' | 'off';
        }
        break;
      case '_debug': // Added this
         if (value !== 'verbose' && value !== false && value !== undefined) {
             errors.push(`- _debug must be 'verbose' or false. Got "${value}"`);
         } else {
             validOptions[key] = value;
         }
         break;
      case 'onCommitStart':
      case 'onCommitFinish':
      case 'onPaintStart':
      case 'onPaintFinish':
      case 'onRender': // Keep validation for potential future use or logging
        if (value !== undefined && typeof value !== 'function') { // Allow undefined
          errors.push(`- ${key} must be a function or undefined. Got "${value}"`);
        } else {
           // Cast to avoid type errors if these are used later
          validOptions[key] = value as any;
        }
        break;
      default:
        // This case should ideally not be reached due to isOptionKey check
         if(ReactScanInternals.options.value._debug) {
           console.warn(`[React Scan] Unknown option slipped through validation: "${key}"`);
        }
    }
  }


  if (errors.length > 0) {
    console.warn(`[React Scan] Invalid options detected:\n${errors.join('\n')}`);
  }

  return validOptions;
};

export const getReport = (type?: ComponentType<unknown>) => {
  if (type) {
    // Check both maps? Or just legacy? Assuming legacy for now.
    for (const reportData of Array.from(Store.legacyReportData.values())) {
      if (reportData.type === type) {
        return reportData;
      }
    }
    // Check the new map by iterating if needed, but needs a way to map type to ID
    // Example (might be slow):
    // for (const [id, reportData] of Store.reportData.entries()) {
    //    // Need a way to get fiber from ID or type from ID
    // }
    return null;
  }
  // Return both maps or a combined representation? Returning legacy for now.
  return Store.legacyReportData;
};

export const setOptions = (userOptions: Partial<Options>) => {
  const validOptions = validateOptions(userOptions);

  if (Object.keys(validOptions).length === 0 && !userOptions.hasOwnProperty('enabled')) { // Check enabled specifically if it's the only key
      // No valid options to set, maybe log in debug mode
       if(ReactScanInternals.options.value._debug === 'verbose') {
          console.log('[React Scan] setOptions called with no valid options or only invalid options.', userOptions);
       }
      return ReactScanInternals.options.value; // Return current options
  }

  const currentOptions = ReactScanInternals.options.value;
  const showToolbarChanged = validOptions.hasOwnProperty('showToolbar') && validOptions.showToolbar !== currentOptions.showToolbar;
  const enabledChanged = validOptions.hasOwnProperty('enabled') && validOptions.enabled !== currentOptions.enabled;


  const newOptions = {
    ...currentOptions,
    ...validOptions,
  };

  const { instrumentation } = ReactScanInternals;
  if (instrumentation && validOptions.hasOwnProperty('enabled')) {
    instrumentation.isPaused.value = validOptions.enabled === false;
  }

  ReactScanInternals.options.value = newOptions;

  // Save options only if they are not the defaults or have changed
  // This prevents unnecessary localStorage writes on initial load if options are default
  // Add a check to see if the new options differ from stored ones before saving?
  // Or just save whenever setOptions is called with valid changes.
  try {
       const storableOptions: Partial<LocalStorageOptions> = {};
       for (const key in newOptions) {
           if (key !== 'onCommitStart' && key !== 'onRender' && key !== 'onCommitFinish' && key !== 'onPaintStart' && key !== 'onPaintFinish') {
            // @ts-expect-error
               storableOptions[key as keyof LocalStorageOptions] = newOptions[key as keyof LocalStorageOptions];
           }
       }
      saveLocalStorage('react-scan-options', storableOptions);
  } catch(e) {
      console.error("[React Scan] Failed to save options to localStorage", e);
  }


  // Re-initialize toolbar *only* if showToolbar explicitly changed
  // or if enabled changed from false to true and showToolbar is true
  if (showToolbarChanged || (enabledChanged && newOptions.enabled === true && newOptions.showToolbar === true)) {
    initToolbar(!!newOptions.showToolbar);
  } else if (enabledChanged && newOptions.enabled === false) {
      // If disabled, ensure toolbar is removed/cleaned up
      initToolbar(false);
  }


  return newOptions;
};

export const getOptions = () => ReactScanInternals.options;

let isProduction: boolean | null = null;
let rdtHook: ReturnType<typeof getRDTHook>;
export const getIsProduction = () => {
  if (isProduction !== null) {
    return isProduction;
  }
   if (!IS_CLIENT) return false; // Cannot determine on server

  try {
      rdtHook ??= getRDTHook();
      if (!rdtHook || !rdtHook.renderers) {
           console.warn("[React Scan] React DevTools hook not found or has no renderers. Assuming development build.");
           isProduction = false;
           return isProduction;
      }
      isProduction = false; // Default to false
      for (const renderer of rdtHook.renderers.values()) {
        const buildType = detectReactBuildType(renderer);
        if (buildType === 'production') {
          isProduction = true;
          break; // Found a production build, no need to check further
        }
      }
  } catch(e) {
      console.error("[React Scan] Error detecting React build type:", e);
      isProduction = false; // Assume dev on error
  }
  return isProduction;
};


export const start = () => {
  try {
    if (!IS_CLIENT) {
      return;
    }

    if (iframeId) {
      // Prevent zoom on mobile and desktop
      const preventDefault = (e: Event) => e.preventDefault();

      // Prevent pinch-to-zoom on mobile
      document.addEventListener('gesturestart', preventDefault, { passive: false });
      document.addEventListener('gesturechange', preventDefault, { passive: false });
      document.addEventListener('gestureend', preventDefault, { passive: false });

      // Prevent zoom with Ctrl/Cmd + scroll wheel
      document.addEventListener(
        'wheel',
        (e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
          }
        },
        { passive: false },
      );

      // Prevent zoom with keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '0')) {
          e.preventDefault();
        }
      });
    }

    // Listen for URL and hash changes
    const handleUrlChange = () => {
      try {
        const currentUrl = window.location.href;
        window.parent.postMessage({
          type: 'IFRAME_URL_CHANGED',
          iframeId,
          payload: { url: currentUrl }
        }, PARENT_ORIGIN);
      } catch (error) {
        console.error("[React Scan Iframe] Error posting URL_CHANGED message:", error);
      }
    };

    // Listen for popstate events (back/forward navigation)
    window.addEventListener('popstate', handleUrlChange);

    // Listen for hashchange events
    window.addEventListener('hashchange', handleUrlChange);

    // Override pushState and replaceState to catch programmatic navigation
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      originalPushState.apply(this, args);
      handleUrlChange();
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(this, args);
      handleUrlChange();
    };

    // Initialize and start observing
    // const resizer = new IframeResizer();
    // // Ensure DOM is ready before trying to get sizes, especially for initial send.
    // if (document.readyState === 'complete' || document.readyState === 'interactive') {
    //     resizer.observe();
    // } else {
    //     document.addEventListener('DOMContentLoaded', () => {
    //         resizer.observe();
    //     });
    // }
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      // Log to console as usual
      originalConsoleError(...args);
      // Send error to parent window if in an iframe
      // if (window.parent !== window) {
        if (args[0] instanceof Error) {
          // If the first argument is an Error object, send its properties
          window.parent.postMessage({
            type: 'IFRAME_ERROR',
            iframeId,
            payload: {
              message: args[0].message || 'Unknown error',
              stack: args[0].stack,
              // @ts-expect-error expect error
              componentStack: args[0].componentStack,
            },
          }, PARENT_ORIGIN); 
        } else if (typeof args[0] === 'string') {
          if (args[0].startsWith('[vite] Internal Server Error')) {
            // Special handling for Vite internal errors
// Here is how vite console errors look like:
// console.error(`[vite] Internal Server Error
// ${err.message}
// ${err.stack}`);
            const errorWithStack = args[0].replace('[vite] Internal Server Error\n', '');
            const errorItself = errorWithStack.split('\n')[0];
            const stack = errorWithStack.split('\n').slice(1).join('\n');
            window.parent.postMessage({
              type: 'IFRAME_ERROR',
              iframeId,
              payload: {
                message: errorItself,
                stack: stack
              },
            }, PARENT_ORIGIN);
          } else if (args[0] === '[vite]') {
            window.parent.postMessage({
              type: 'IFRAME_ERROR',
              iframeId,
              payload: {
                message: args[1],
              },
            }, PARENT_ORIGIN);
          } else {
            // If the first argument is a string, send it as the message
            window.parent.postMessage({
              type: 'IFRAME_ERROR',
              iframeId,
              payload: {
                message: args[0],
              },
            }, PARENT_ORIGIN);
          }
        }
      // }
    };
    window.addEventListener('error', ({ error }) => {
      // if (window.parent !== window) {
        // Send error to parent window if in an iframe
        window.parent.postMessage({
          type: 'IFRAME_ERROR',
          iframeId,
          payload: {
            message: error?.message || 'Unknown error',
            stack: error?.stack,
            componentStack: error?.componentStack,
          },
        }, PARENT_ORIGIN);
      // }
    });

    // Add the listener regardless of production status or other options
    addMessageListener();


    // Send load success message *after* listener is added, if in an iframe
    if (Store.isInIframe.value) {
        const PARENT_ORIGIN = '*'; // WARNING: Use specific origin in production!
        window.parent.postMessage({
            type: 'IFRAME_LOAD_SUCCESS',
            iframeId,
            payload: {} // No specific payload needed for now
        }, PARENT_ORIGIN);
        console.log('[React Scan Iframe] Sent IFRAME_LOAD_SUCCESS to parent.');
    }

    const isProd = getIsProduction(); // Determine production status

    if (
      isProd &&
      !ReactScanInternals.options.value.dangerouslyForceRunInProduction
    ) {
      console.log('[React Scan] Production environment detected. React Scan disabled unless dangerouslyForceRunInProduction is set.');
      // Return here *after* adding the listener if we don't force run in prod
      return;
    }

    // Load stored options *after* the production check
    const localStorageOptions =
      readLocalStorage<LocalStorageOptions>('react-scan-options');

    let initialOptions = { ...ReactScanInternals.options.value };
    if (localStorageOptions) {
      const validLocalOptions = validateOptions(localStorageOptions);
      initialOptions = { ...initialOptions, ...validLocalOptions };
    }
    // Update the signal *once* after merging defaults and stored options
    ReactScanInternals.options.value = initialOptions;

    const options = initialOptions; // Use the merged options

    // Initialize React instrumentation if enabled
    if (options.enabled !== false) {
      initReactScanInstrumentation(() => {
        // Callback for when instrumentation is active
        initToolbar(!!options.showToolbar);
      });
    } else if (options.showToolbar === true) {
        // If scanning is disabled but toolbar is shown, init toolbar without instrumentation callback
        initToolbar(true);
    }

    document.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('keydown', handleKeyEvent, true);
    window.addEventListener('keyup', handleKeyEvent, true);

    // Original check for instrumentation activation delay - keep this
    if (!Store.monitor.value && IS_CLIENT) {
      setTimeout(() => {
        if (isInstrumentationActive()) return;
        console.error(
          '[React Scan] Failed to load React instrumentation. This can happen if React runs before React Scan is imported, or if React DevTools are disabled or interfering. Ensure React Scan is imported early.'
        );
      }, 5000);
    }
  } catch (e) {
    console.error('[React Scan] Error during start():', e);
  }
};


const initToolbar = (showToolbar: boolean) => {
  try {
      window.reactScanCleanupListeners?.(); // Cleanup previous listeners if any

      const windowToolbarContainer = document.getElementById('react-scan-toolbar-root');
      if (windowToolbarContainer) {
          windowToolbarContainer.remove();
          // Clear the reference in case it was cached elsewhere, though direct ID access is safer
          // window.__REACT_SCAN_TOOLBAR_CONTAINER__ = undefined;
      }


      if (!showToolbar) {
         window.reactScanCleanupListeners = undefined; // Ensure no listeners if toolbar hidden
         return; // Don't create toolbar if not needed
      }


      // Create toolbar only if shown
      const { shadowRoot } = initRootContainer(); // Ensure root container exists
      createToolbar(shadowRoot); // Render toolbar into shadow DOM

      // Start necessary listeners only when toolbar is shown
      const cleanupTimingTracking = startTimingTracking();
      const cleanupOutlineCanvas = createNotificationsOutlineCanvas();

      window.reactScanCleanupListeners = () => {
        cleanupTimingTracking();
        cleanupOutlineCanvas?.();
        // Optionally remove the toolbar container on cleanup?
        // document.getElementById('react-scan-toolbar-root')?.remove();
      };

  } catch (e) {
       console.error("[React Scan] Error initializing toolbar:", e);
       window.reactScanCleanupListeners = undefined; // Clear listeners on error
  }
};


const createNotificationsOutlineCanvas = () => {
  try {
    // Ensure it runs in the client context
    if (!IS_CLIENT) return undefined;
    const highlightRoot = document.documentElement;
    // Cleanup existing canvas before creating a new one
    const existingCanvas = highlightRoot.querySelector('canvas[style*="z-index: 2147483600"]');
    existingCanvas?.remove();

    return createHighlightCanvas(highlightRoot);
  } catch (e) {
    console.error('[React Scan] Failed to create notifications outline canvas:', e);
    return undefined; // Return undefined if creation fails
  }
};


export const scan = (options: Options = {}) => {
  setOptions(options); // Update and save options
  addMessageListener(); // Ensure listener is always added (idempotent)

  // Start instrumentation/UI based on the *updated* options
  const currentOptions = ReactScanInternals.options.value;
  if (currentOptions.enabled !== false || currentOptions.showToolbar === true) {
     start();
  } else {
      // If options explicitly disable and hide toolbar, ensure cleanup
      initToolbar(false);
      // Consider stopping instrumentation if it was running?
      // ReactScanInternals.instrumentation?.isPaused.value = true;
  }
};


export const useScan = (options: Options = {}) => {
  // This hook implies usage within a React component, likely client-side
  if (!IS_CLIENT) return; // Basic guard

  // Use effect to apply options only once on mount/options change?
  // Or just call scan directly? Calling directly might be simpler.
  scan(options); // Apply options and start/stop as needed

  // Hooks usually don't return anything for side effects like this.
  // Could return status or methods if needed later.
};


export const onRender = (
  type: unknown,
  _onRender: (fiber: Fiber, renders: Array<Render>) => void,
) => {
  // Ensure type is valid for comparison (function or class component type)
   if (!type || (typeof type !== 'function' && typeof type !== 'object')) {
      console.warn("[React Scan] Invalid type provided to onRender. Expected component type.", type);
      return;
   }


  const prevOnRender = ReactScanInternals.onRender;
  ReactScanInternals.onRender = (fiber: Fiber, renders: Array<Render>) => {
    // Call previous listener first if it exists
    prevOnRender?.(fiber, renders);
    // Use bippy's getType for consistent comparison, comparing against the provided type
    if (getType(fiber.type) === type) {
      try {
          _onRender(fiber, renders);
      } catch (e) {
          console.error("[React Scan] Error in onRender callback for type:", type, e);
      }
    }
  };
};


export const ignoredProps = new WeakSet<
  Exclude<ReactNode, undefined | null | string | number | boolean | bigint>
>();

export const ignoreScan = (node: ReactNode) => {
  // Ensure node is an object (like a React element) before adding
  if (node && typeof node === 'object') {
    ignoredProps.add(node);
  }
};


// Ensure addMessageListener is called when the module loads in a client environment
if (IS_CLIENT) {
    addMessageListener();
    // Optionally trigger start() based on some initial condition or stored options?
    // Example: Start if previously enabled and not in production (unless forced)
    // const storedOpts = readLocalStorage<LocalStorageOptions>('react-scan-options');
    // if (storedOpts?.enabled !== false && (!getIsProduction() || storedOpts?.dangerouslyForceRunInProduction)) {
    //    start();
    // }
    // Or simply rely on explicit `scan()` call by the user.
}
