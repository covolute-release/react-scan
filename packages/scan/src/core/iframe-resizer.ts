// Define the structure of the message we'll send to the parent
interface IframeSizeMessage {
  type: 'iframeResize';
  payload: {
    width: number;
    height: number;
    iframeId?: string; // Optional: if parent needs to identify which iframe
  };
}

export class IframeResizer {
  private iframeId: string | undefined;

  constructor() {
    // Optional: Try to get an ID for this iframe from the URL query parameters
    // e.g., if your iframe src is "page.html?iframeId=myCoolIframe"
    const urlParams = new URLSearchParams(window.location.search);
    this.iframeId = urlParams.get('iframeId') || undefined;

    this.sendSize = this.sendSize.bind(this); // Ensure 'this' is correct in callbacks
  }

  private getCurrentSize(): { width: number; height: number } {
    // Use scrollHeight/Width as it usually reflects the full content size
    //documentElement is often better for full page height, body for specific content areas
    const height = Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight,
      document.body.clientHeight
    );
    const width = Math.max(
      document.body.scrollWidth,
      document.body.offsetWidth,
      document.body.clientWidth,
      document.documentElement.clientWidth
    );
    return { width, height };
  }

  private sendMessage(width: number, height: number): void {
    const message: IframeSizeMessage = {
      type: 'iframeResize',
      payload: {
        width,
        height,
        iframeId: this.iframeId,
      },
    };
    // Send to parent window. '*' for targetOrigin is less secure but common for this.
    // For better security, replace '*' with the parent window's origin if known.
    // e.g., 'https://your-parent-domain.com'
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, '*');
      // console.log('IFRAME: Sent size:', message.payload);
    } else {
      console.warn('IFRAME: No parent window found to send message to.');
    }
  }

  public sendSize(): void {
    const { width, height } = this.getCurrentSize();
    this.sendMessage(width, height);
  }

  public observe(): void {
    // Send initial size
    // Use a small timeout to allow content (like images) to potentially load and affect size
    setTimeout(() => {
        this.sendSize();
    }, 100); // Adjust timeout as needed, or send on DOMContentLoaded/load


    // Use ResizeObserver to detect content size changes
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(this.sendSize);
      // Observe the body or a specific wrapper element if your content is contained
      resizeObserver.observe(document.body);
      // You might also want to observe document.documentElement if body height is 100%
      // resizeObserver.observe(document.documentElement);
    } else {
      // Fallback for older browsers (less efficient)
      console.warn('IFRAME: ResizeObserver not supported. Falling back to interval/event listeners.');
      window.addEventListener('resize', this.sendSize); // Window resize
      // Polling for content changes (use sparingly, can be performance intensive)
      // setInterval(this.sendSize, 1000);
    }

    // Also send size on specific events that might change content
    window.addEventListener('load', this.sendSize); // After all resources are loaded
  }
}

// Example: Function to dynamically add content to test resizing
/*
function addContent() {
  const p = document.createElement('p');
  p.textContent = 'New dynamic content added at ' + new Date().toLocaleTimeString();
  document.body.appendChild(p);
  // ResizeObserver should pick this up automatically.
  // If not using ResizeObserver, you might need to call resizer.sendSize() manually here.
}
setTimeout(() => addContent(), 3000);
setTimeout(() => addContent(), 5000);
*/