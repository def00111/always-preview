"use strict";
const {runtime, webRequest} = browser;

const APPLICATION_PDF = "application/pdf";

const HEX_ESCAPE_REGEXP = /%[0-9A-Fa-f]{2}/;

const BASE64_REGEXP = /(?:[a-z0-9+\/]{4})*(?:[a-z0-9+\/]{2}==|[a-z0-9+\/]{3}=)/i;

const SEPARATOR_REGEXP = /(?:;|,)/;

if (!String.prototype.trimAll) {
  String.prototype.trimAll = function () {
    return this.replace(/[\s\uFEFF\xA0]+/g, ''); // taken from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/Trim
  };
}

let filenames = new Map();

let myListener = {
  events: ["onCompleted", "onErrorOccurred", "onBeforeRedirect"],

  add(filter) {
    this.callback = this.check.bind(this);

    for (let event of this.events) {
      webRequest[event].addListener(this.callback, filter);
    }
  },

  remove() {
    for (let event of this.events) {
      if (webRequest[event].hasListener(this.callback)) {
        webRequest[event].removeListener(this.callback);
      }
    }
    delete this.callback;
  },

  check(details) {
    this.remove();

    if (filenames.has(details.url)) {
      let filename = filenames.get(details.url);
      if (details.redirectUrl) {
        filenames.set(details.redirectUrl, filename);

        this.add({
          urls: [details.redirectUrl],
          tabId: details.tabId,
        });
      }
      filenames.delete(details.url);
    }
  },
};

function handleMessage(request, sender, sendResponse) {
  if (!sender.tab || sender.id != runtime.id) {
    return;
  }

  let url = request.url;
  if (!filenames.has(url)) {
    filenames.set(url, request.download);

    myListener.add({
      urls: [url],
      tabId: sender.tab.id,
    });
    sendResponse({ok: true});
  }
}

runtime.onMessage.addListener(handleMessage);

function processHeaders(details) {
  if (details.method !== "GET" ||
      details.statusCode !== 200) {
    return;
  }

  let contentTypeHeader = null;
  let contentDispositionHeader = null;
  for (let header of details.responseHeaders) {
    switch (header.name.toLowerCase()) {
      case "content-disposition":
        contentDispositionHeader = header;
        break;
      case "content-type":
        contentTypeHeader = header;
        break;
    }
  }

  let filename = "", isAttachment = false;
  if (filenames.has(details.url)) {
    filename = filenames.get(details.url);
    if (filename != "") {
      contentDispositionHeader = {
        name: "content-disposition",
        value: `attachment; filename="${filename}"`
      };
    }
    else {
      contentDispositionHeader = {
        name: "content-disposition",
        value: "attachment"
      };
    }
    details.responseHeaders.push(contentDispositionHeader);
    isAttachment = true; // there is a download attribute
  }

  let contentDisposition;
  if (contentDispositionHeader != null &&
      contentDispositionHeader.value != null) {
    contentDisposition = contentDispositionHeader.value;
  }

  if (!filename && typeof contentDisposition == "string" &&
      contentDisposition.toLowerCase().includes("filename")) {
    let matches = /(?:^|;)\s*filename([=\*]*)\s*=\s*((\\?['"])(.*?)\3|[^;\n]*)/i.exec(contentDisposition);
    if (matches != null) {
      filename = matches.filter(m => m != null).pop().trim();
      if (filename != "") {
        if (matches[1]) {
          filename = filename.replace(/^[^']+'[^']*'/, '');
        }
        if (HEX_ESCAPE_REGEXP.test(filename)) {
          let parm = `filename*=utf-8''${filename}`;
          try {
            filename = decodeURIComponent(filename);
          }
          catch (ex) {
            parm = `filename*=iso-8859-1''${filename}`;
          }
          if (matches[1] != "*") {
            contentDisposition = contentDisposition.replace(matches[0], parm);
            contentDispositionHeader.value = contentDisposition;
          }
        }
        else if (/\s/.test(filename) && (!matches[3] || matches[3] != "\"")) {
          // fix firefox bug :(
          // https://bugzilla.mozilla.org/show_bug.cgi?id=221028
          contentDisposition = contentDisposition.replace(matches[2], `"${filename}"`);
          contentDispositionHeader.value = contentDisposition;
        }
        else if (BASE64_REGEXP.test(filename)) {
          filename = atob(BASE64_REGEXP.exec(filename)[0]);
        }
      }
    }
  }

  let contentType;
  if (contentTypeHeader != null &&
      contentTypeHeader.value != null) {
    contentType = contentTypeHeader.value;
  }

  if (contentType != APPLICATION_PDF &&
      typeof contentType == "string") {
    if (SEPARATOR_REGEXP.test(contentType)) {
      contentType = contentType.split(SEPARATOR_REGEXP, 1)[0];
    }
    contentType = contentType.trimAll().toLowerCase();
    if (contentType != APPLICATION_PDF &&
        /^(?:app[a-z]+\\?\/)?(?:x-?)?pdf$/.test(contentType)) {
      contentType = APPLICATION_PDF;
    }
  }

  if (contentType != APPLICATION_PDF &&
      filename != "" &&
      /\.pdfx?$/i.test(filename)) {
    contentType = APPLICATION_PDF;
  }

  if (contentType != APPLICATION_PDF &&
      contentType != "text/html" &&
      /^[^?#;]+\.pdfx?(?=$|[?#;])/i.test(details.url)) {
    contentType = APPLICATION_PDF;
  }

  if (contentType != APPLICATION_PDF) {
    if (isAttachment != false) {
      return {
        responseHeaders: details.responseHeaders
      };
    }
    return;
  }

  if (contentTypeHeader != null) {
    if (contentTypeHeader.value != contentType) {
      contentTypeHeader.value = contentType;
    }
  }
  else {
    details.responseHeaders.push({
      name: "content-type",
      value: contentType
    });
  }

  if (contentDispositionHeader != null) {
    let parts = contentDispositionHeader.value.split(";");
    if (parts.length > 1) {
      let firstPart = parts[0].trim().toLowerCase();
      if (firstPart != "inline" && !firstPart.startsWith("filename")) {
        parts[0] = "inline";
        contentDispositionHeader.value = parts.join(";");
      }
    }
    else {
      contentDisposition = contentDisposition.trim().toLowerCase();
      if (!(contentDisposition.startsWith("filename")
          || contentDisposition == "inline")) {
        contentDispositionHeader.value = "inline";
      }
    }
  }
  else {
    details.responseHeaders.push({
      name: "content-disposition",
      value: "inline"
    });
  }

  return {
    responseHeaders: details.responseHeaders
  };
}

webRequest.onHeadersReceived.addListener(
  processHeaders,
  {urls: ["<all_urls>"], types: ["main_frame"]},
  ["blocking", "responseHeaders"]
);
