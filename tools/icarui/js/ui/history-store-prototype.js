// P4R-2A only: isolated UndoHistory CAS helper. Never loaded by index.html.
(function (root) {
  "use strict";
  const api = {};
  function nextRevision(current) {
    return current === null ? 1 : current + 1;
  }
  function compare(expected, actual) {
    if (expected === null && actual === null) return { ok: true, next: 1 };
    if (expected === actual && Number.isInteger(actual)) return { ok: true, next: actual + 1 };
    return { ok: false, reason: "conflict", expected: expected, actual: actual };
  }
  function put(db, historyId, expectedRevision, bundle) {
    return new Promise(function (resolve) {
      let tx;
      try { tx = db.transaction(["undoHistory"], "readwrite"); }
      catch (e) { resolve({ ok: false, reason: "transaction", detail: e.message }); return; }
      const store = tx.objectStore("undoHistory");
      const req = store.get(historyId);
      let result = null;
      req.onsuccess = function () {
        const actual = req.result && Number.isInteger(req.result.revision) ? req.result.revision : null;
        const cmp = compare(expectedRevision, actual);
        if (!cmp.ok) {
          result = cmp;
          return;
        }
        const record = Object.assign({}, bundle, {
          historyId: historyId,
          revision: cmp.next,
          expectedRevision: expectedRevision,
          savedAt: Date.now(),
        });
        store.put(record);
        result = { ok: true, revision: cmp.next };
      };
      req.onerror = function () { result = { ok: false, reason: "read-failed" }; };
      tx.oncomplete = function () { resolve(result || { ok: false, reason: "no-result" }); };
      tx.onerror = function () { resolve({ ok: false, reason: "transaction", detail: tx.error && tx.error.message }); };
      tx.onabort = function () { resolve({ ok: false, reason: "aborted" }); };
    });
  }
  api.nextRevision = nextRevision;
  api.compare = compare;
  api.put = put;
  root.P4R2AHistoryStorePrototype = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
