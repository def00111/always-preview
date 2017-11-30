"use strict";
const {runtime} = browser;

function onClick(event) {
  if (!event.isTrusted || event.defaultPrevented || event.button != 0) {
    return;
  }

  if (event.ctrlKey || event.shiftKey ||
      event.metaKey || event.altKey) {
    return;
  }

  let node = event.target;
  if (node == document.body) {
    return;
  }

  for (; node != document.body; node = node.parentElement) {
    if (node instanceof HTMLAnchorElement ||
        node instanceof HTMLAreaElement ||
        node instanceof SVGAElement) {
      break;
    }
  }

  if (node == document.body || !node.hasAttribute("download")) {
    return;
  }

  let url = node.href;
  if (url) {
    // Handle SVG links:
    if (typeof url == "object" && url.animVal) {
      url = url.animVal;
    }
  }

  if (!url) {
    let href = node.getAttribute("href") ||
               node.getAttributeNS("http://www.w3.org/1999/xlink", "href");

    if (href && /\S/.test(href)) {
      url = new URL(href, node.baseURI).href;
    }
  }

  if (!url) {
    return;
  }

  let origin = node.origin;
  if (!origin) {
    origin = new URL(url).origin;
  }

  if (origin != window.location.origin) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();

  let download = node.download.trim();
  let sending = runtime.sendMessage({url, download});
  sending.then((message = {}) => {
    if (message.ok == true) {
      window.location.href = url;
    }
  }).catch(error => {
    console.error(error);
    node.click();
  });
}

if (window.origin != "resource://pdf.js") {
  window.addEventListener("click", onClick, true);
}
