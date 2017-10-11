"use strict";
const {runtime, webRequest} = browser;

const APPLICATION_PDF = "application/pdf";

// https://www.npmjs.com/package/base64-regex
const BASE64_REGEXP = /(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)/;

// https://stackoverflow.com/questions/23054475/javascript-regex-for-extracting-filename-from-content-disposition-header/23054920
const FILENAME_REGEXP = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i;

let filenames = new Map();

let myListener = {
  events: ["onCompleted", "onErrorOccurred", "onBeforeRedirect"],

  addListeners(filter) {
    this.callback = this.check.bind(this);

    for (let event of this.events) {
      webRequest[event].addListener(this.callback, filter);
    }
  },

  removeListeners() {
    for (let event of this.events) {
      if (webRequest[event].hasListener(this.callback)) {
        webRequest[event].removeListener(this.callback);
      }
    }
    delete this.callback;
  },

  check(details) {
    if (filenames.has(details.url)) {
      if (details.redirectUrl) {
        filenames.set(details.redirectUrl, filenames.get(details.url));
      }
      filenames.delete(details.url);
    }
    this.removeListeners();

    if (details.redirectUrl) {
      this.addListeners({
        urls: [details.redirectUrl],
        tabId: details.tabId
      });
    }
  },
};

runtime.onMessage.addListener((message, sender) => {
  if (sender.id != "{b434be68-4cab-41e0-9141-9f8d00373d93}") {
    return;
  }

  if (!sender.tab) {
    return;
  }

  let url = message.url;
  if (!filenames.has(url)) {
    filenames.set(url, message.filename);

    myListener.addListeners({
      urls: [url],
      tabId: sender.tab.id
    });
  }
});

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
    filenames.delete(details.url);

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
      typeof contentDispositionHeader.value == "string") {
    contentDisposition = contentDispositionHeader.value;
  }

  if (!filename && typeof contentDisposition == "string" &&
      contentDisposition.toLowerCase().includes("filename")) {
    let m = FILENAME_REGEXP.exec(contentDisposition);
    if (m != null && m.length > 1) {
      if (m[0].toLowerCase().startsWith("filename*")) {
        filename = m[1].replace(/^.+'.*'/, "");
        try {
          filename = decodeURIComponent(filename);
        }
        catch (ex) {
        }
      }
      else {
        if (/%[0-9A-Fa-f]{2}/.test(m[1])) {
          try {
            filename = decodeURIComponent(m[1]);
          }
          catch (ex) {
            filename = m[1];
          }
        }
        else {
          filename = m[1].replace(/^\s*\\?['"]?/, "").replace(/\\?['"]?\s*$/, "");
        }

        if (filename != "") {
          if (/\s/.test(filename) && (!m[2] || m[2] != "\"")) {
            // fix firefox bug :(
            // https://bugzilla.mozilla.org/show_bug.cgi?id=221028
            contentDisposition = contentDisposition.replace(m[1], `"${filename}"`);
            contentDispositionHeader.value = contentDisposition;
          }

          if (BASE64_REGEXP.test(filename)) {
            filename = atob(BASE64_REGEXP.exec(filename)[0]);
          }
        }
      }
    }
  }

  let contentType;
  if (contentTypeHeader != null &&
      typeof contentTypeHeader.value == "string" &&
      contentTypeHeader.value != "") {
    contentType = contentTypeHeader.value;
  }

  let originalType = contentType || "";
  if (typeof contentType == "string" &&
      contentType != APPLICATION_PDF) {
    if (contentType.includes(";")) {
      contentType = contentType.split(";", 1)[0];
    }
    contentType = contentType.replace(/ /g, "").toLowerCase();
    if (contentType != APPLICATION_PDF &&
        /^(?:app[acilnot]+\/)?(?:x-)?pdf$/.test(contentType)) {
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
      /^[^?#;]+\.pdfx?(?=$|[#?;])/i.test(details.url)) {
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

  if (originalType != contentType) {
    if (contentTypeHeader != null) {
      contentTypeHeader.value = contentType;
    }
    else {
      details.responseHeaders.push({
        name: "content-type",
        value: contentType
      });
    }
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
