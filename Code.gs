/**
 * Drive Folder Copier - Apps Script web app (server side)
 *
 * Copies one or more whole Google Drive folder trees (e.g. folders shared with
 * you) into YOUR Drive, in a single job. All copying happens inside Google;
 * nothing is downloaded.
 *
 * Design:
 *  - Talks to the Drive REST API through UrlFetchApp.fetchAll, so several files
 *    are copied in parallel and folders are listed 1000 items per request.
 *  - A job is a list of "jobs" (one per source folder pasted in), each its own
 *    stack of (sourceFolder, destFolder) tasks. Jobs run one at a time, in
 *    order. All of it is stored in PropertiesService, so a job survives the
 *    6-minute limit, closed tabs and crashes. Every step is idempotent: it
 *    looks at what already exists in the destination and only copies what is
 *    missing, so resuming never duplicates.
 *  - The web page drives the job in short steps (~20 s each) for live progress.
 *    Optionally a 1-minute time trigger keeps it running with the tab closed.
 */

const CFG = {
  STEP_BUDGET_MS: 20 * 1000,       // per call from the web page
  BG_BUDGET_MS: 4.5 * 60 * 1000,   // per background trigger run (hard limit is 6 min)
  CONCURRENCY: 8,                  // parallel copy requests
  MAX_RETRIES: 5,                  // per request, with exponential backoff
  MAX_FOLDER_ATTEMPTS: 5,          // no-progress passes before giving up on a folder
  MAX_ISSUES_STORED: 300,          // per source folder
  MAX_SOURCES: 20,                 // folders allowed in one job
  DEFAULT_SUFFIX: ' (Copy)',
  PREVIEW_BUDGET_MS: 15 * 1000,    // preview is a single synchronous call, kept short
  MAX_PREVIEW_ITEMS: 400,          // total items walked, across all pasted sources
  MAX_PREVIEW_DEPTH: 6,
  MAX_PREVIEW_FILES_SHOWN: 30      // per folder, before "+N more files"
};

const API = 'https://www.googleapis.com/drive/v3/files';
const ABOUT_API = 'https://www.googleapis.com/drive/v3/about';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const ARCHIVE_MIMES = ['application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed',
  'application/vnd.rar', 'application/x-7z-compressed', 'application/x-tar', 'application/gzip', 'application/x-gzip'];

// ---------------------------------------------------------------- web app ----

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Drive Folder Copier')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ------------------------------------------------- functions the page calls ----

function api_status() {
  return publicStatus_(loadState_(), false);
}

/** Live Drive storage usage. Deliberately not called on every step - only polled occasionally. */
function api_storage() {
  const r = fetchBatch_([req_('get', ABOUT_API + '?fields=storageQuota')])[0];
  if (!r.ok) return { usage: null, limit: null };
  const q = r.body.storageQuota || {};
  return {
    usage: q.usage !== undefined ? Number(q.usage) : null,
    limit: q.limit !== undefined ? Number(q.limit) : null   // absent/null means unlimited storage on the account
  };
}

/**
 * Read-only folder-tree preview for the sources currently typed into the form
 * (same parsing as api_start, but nothing is created or copied). Bounded by
 * time, depth and total item count so a huge folder can't make this call slow
 * or expensive - it's meant to answer "is this the right folder?", not to
 * count everything.
 */
function api_preview(sourceInput) {
  const lines = String(sourceInput || '').split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!lines.length) throw new Error('Paste at least one folder link or ID.');
  if (lines.length > CFG.MAX_SOURCES) {
    throw new Error('You can preview up to ' + CFG.MAX_SOURCES + ' folders at a time.');
  }
  const ids = [];
  lines.forEach(function (line) {
    const id = parseId_(line);
    if (!id) throw new Error('Could not find a folder ID in: ' + line);
    if (ids.indexOf(id) === -1) ids.push(id);
  });

  const budget = { items: 0, deadline: Date.now() + CFG.PREVIEW_BUDGET_MS };
  return ids.map(function (id) {
    const f = getFile_(id, 'source folder');
    if (f.mimeType !== FOLDER_MIME) throw new Error('"' + f.name + '" is a file, not a folder.');
    const node = { name: f.name, type: 'folder', files: 0, folders: 0, children: [], truncated: false };
    scanNode_(f.id, node, 0, budget);
    return node;
  });
}

function scanNode_(folderId, node, depth, budget) {
  if (Date.now() > budget.deadline || depth >= CFG.MAX_PREVIEW_DEPTH || budget.items >= CFG.MAX_PREVIEW_ITEMS) {
    node.truncated = true;
    return;
  }
  const remaining = Math.max(1, Math.min(200, CFG.MAX_PREVIEW_ITEMS - budget.items));
  let res;
  try { res = listChildrenCapped_(folderId, remaining); } catch (e) { node.truncated = true; return; }

  const items = res.items.slice().sort(function (a, b) {
    const af = a.mimeType === FOLDER_MIME, bf = b.mimeType === FOLDER_MIME;
    if (af !== bf) return af ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  let shownFiles = 0;
  for (let i = 0; i < items.length; i++) {
    if (Date.now() > budget.deadline || budget.items >= CFG.MAX_PREVIEW_ITEMS) { node.truncated = true; break; }
    const it = items[i];
    budget.items++;
    if (it.mimeType === FOLDER_MIME) {
      node.folders++;
      const child = { name: it.name, type: 'folder', files: 0, folders: 0, children: [], truncated: false };
      node.children.push(child);
      scanNode_(it.id, child, depth + 1, budget);
    } else {
      node.files++;
      if (shownFiles < CFG.MAX_PREVIEW_FILES_SHOWN) {
        node.children.push({ name: it.name, type: it.mimeType === SHORTCUT_MIME ? 'shortcut' : 'file' });
        shownFiles++;
      }
    }
  }
  if (res.more) node.truncated = true;
}

/** Like listChildren_, but stops after maxItems items instead of paginating through everything. */
function listChildrenCapped_(folderId, maxItems) {
  const out = [];
  let pageToken = '';
  do {
    const url = API +
      '?q=' + encodeURIComponent("'" + folderId + "' in parents and trashed=false") +
      '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType)') +
      '&pageSize=' + Math.min(1000, maxItems - out.length) + '&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const r = fetchBatch_([req_('get', url)])[0];
    if (!r.ok) return { items: out, more: true };
    (r.body.files || []).forEach(function (f) { out.push(f); });
    pageToken = r.body.nextPageToken || '';
  } while (pageToken && out.length < maxItems);
  return { items: out, more: !!pageToken };
}

/**
 * sourceInput: one or more folder links/IDs, separated by newlines or commas.
 * Merge mode only supports a single source at a time.
 * filterOpts (optional): { skipVideos, skipImages, skipAudio, skipPdf, skipGoogleDocs, skipArchives, skipExt: [...] }
 */
function api_start(sourceInput, destInput, suffix, merge, filterOpts) {
  const existing = loadState_();
  if (existing && !existing.done) {
    throw new Error('A copy job is already in progress. Resume it or cancel it first.');
  }
  const isMerge = merge === true || merge === 'true';

  const lines = String(sourceInput || '').split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!lines.length) throw new Error('Paste at least one folder link or ID.');
  if (lines.length > CFG.MAX_SOURCES) {
    throw new Error('You can copy up to ' + CFG.MAX_SOURCES + ' folders in one job - remove some links and run the rest separately.');
  }
  if (isMerge && lines.length > 1) {
    throw new Error('Merge mode works with one folder at a time - remove the extra links, or turn off merge and copy them normally.');
  }

  const srcIds = [];
  lines.forEach(function (line) {
    const id = parseId_(line);
    if (!id) throw new Error('Could not find a folder ID in: ' + line);
    if (srcIds.indexOf(id) === -1) srcIds.push(id);   // silently drop exact duplicates
  });

  const srcs = srcIds.map(function (id) {
    const f = getFile_(id, 'source folder');
    if (f.mimeType !== FOLDER_MIME) throw new Error('"' + f.name + '" is a file, not a folder.');
    return f;
  });

  const hasDest = !!(destInput && String(destInput).trim());
  if (isMerge && !hasDest) {
    throw new Error('Merge mode needs the link of the existing folder to merge into.');
  }

  let dest;                                    // the folder the copy goes into (or merges into)
  if (hasDest) {
    const destId = parseId_(destInput);
    if (!destId) throw new Error('Could not find a folder ID in the destination link.');
    dest = getFile_(destId, isMerge ? 'folder to merge into' : 'destination folder');
    if (dest.mimeType !== FOLDER_MIME) throw new Error('The destination link is not a folder.');
  } else {
    dest = getFile_('root', 'My Drive');
  }

  // Copying a folder into itself (or into one of its own subfolders) would never end.
  srcs.forEach(function (src) {
    if (isInsideOrSame_(dest.id, src.id)) {
      throw new Error(isMerge
        ? 'The folder to merge into cannot be "' + src.name + '" or inside it.'
        : 'The destination cannot be "' + src.name + '" or inside it.');
    }
  });

  const jobs = [];
  if (isMerge) {
    jobs.push(newJob_(srcs[0], dest.id, 'https://drive.google.com/drive/folders/' + dest.id, true, dest.name));
  } else {
    // Create every destination folder up front, in one batch, so a mid-way
    // failure (e.g. one bad name) aborts before anything is saved as a job.
    const names = srcs.map(function (src) {
      return src.name + (suffix === null || suffix === undefined ? CFG.DEFAULT_SUFFIX : suffix);
    });
    const created = fetchBatch_(names.map(function (name) { return folderReq_(name, dest.id); }));
    created.forEach(function (r, i) {
      if (!r.ok) throw new Error('Could not create the destination folder for "' + srcs[i].name + '": ' + r.message);
    });
    srcs.forEach(function (src, i) {
      const rootId = created[i].body.id;
      jobs.push(newJob_(src, rootId, 'https://drive.google.com/drive/folders/' + rootId, false, null));
    });
  }

  const st = { jobs: jobs, cur: 0, filter: normalizeFilter_(filterOpts), fatal: null, done: false, bg: false, startedAt: Date.now() };
  saveState_(st);
  return publicStatus_(st, false);
}

function newJob_(src, rootId, rootUrl, isMerge, destName) {
  return {
    srcName: src.name,
    merge: isMerge,
    destName: destName,
    rootId: rootId,
    rootUrl: rootUrl,
    queue: [[src.id, rootId, 0, 0]],
    files: 0,
    skipped: 0,
    filtered: 0,
    bytes: 0,
    foldersDone: 0,
    issues: [],
    issuesOverflow: false
  };
}

/** Cleans up the filter options sent from the page. Returns null if nothing is actually being filtered. */
function normalizeFilter_(f) {
  if (!f) return null;
  const rawExt = Array.isArray(f.skipExt) ? f.skipExt : String(f.skipExt || '').split(',');
  const skipExt = rawExt.map(function (e) { return String(e || '').trim().replace(/^\./, '').toLowerCase(); }).filter(Boolean);
  const out = {
    skipVideos: !!f.skipVideos, skipImages: !!f.skipImages, skipAudio: !!f.skipAudio,
    skipPdf: !!f.skipPdf, skipGoogleDocs: !!f.skipGoogleDocs, skipArchives: !!f.skipArchives,
    skipExt: skipExt
  };
  const any = out.skipVideos || out.skipImages || out.skipAudio || out.skipPdf || out.skipGoogleDocs || out.skipArchives || out.skipExt.length;
  return any ? out : null;
}

function isFiltered_(item, filter) {
  if (!filter) return false;
  const mt = item.mimeType;
  if (filter.skipVideos && /^video\//.test(mt)) return true;
  if (filter.skipImages && /^image\//.test(mt)) return true;
  if (filter.skipAudio && /^audio\//.test(mt)) return true;
  if (filter.skipPdf && mt === 'application/pdf') return true;
  if (filter.skipGoogleDocs && /^application\/vnd\.google-apps\./.test(mt)) return true;
  if (filter.skipArchives && ARCHIVE_MIMES.indexOf(mt) !== -1) return true;
  if (filter.skipExt.length) {
    const dot = item.name.lastIndexOf('.');
    if (dot > 0 && filter.skipExt.indexOf(item.name.slice(dot + 1).toLowerCase()) !== -1) return true;
  }
  return false;
}

/** One short slice of work. The page calls this in a loop until done. */
function api_step() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(3000)) return publicStatus_(loadState_(), true); // background run is active
  try {
    const st = loadState_();
    if (!st) throw new Error('No job found. Start a new copy.');
    if (!st.done && !st.fatal) runBatch_(st, CFG.STEP_BUDGET_MS);
    return publicStatus_(st, false);
  } finally {
    lock.releaseLock();
  }
}

/** After a quota/storage stop: clear the stop flag so the page can continue. */
function api_clearStop() {
  const st = loadState_();
  if (st) { st.fatal = null; saveState_(st); }
  return publicStatus_(st, false);
}

function api_cancel() {
  removeTriggers_();
  clearJobState_();
  return publicStatus_(null, false);
}

/**
 * Undo: moves every folder this job CREATED to Trash (recoverable for 30 days - this
 * never permanently deletes). Blocked for a merge job, since there the destination
 * folder already existed before the job and holds the user's own other files too -
 * "undo" would mean deleting things this tool never created.
 */
function api_deleteCopies() {
  const st = loadState_();
  if (!st) throw new Error('No job found.');
  if (!st.done && !st.fatal) throw new Error('Stop or finish the job before deleting the copy.');
  if (st.jobs.some(function (j) { return j.merge; })) {
    throw new Error('This job merged into a folder you already had - there is no new folder to delete.');
  }
  const results = fetchBatch_(st.jobs.map(function (j) {
    return req_('patch', API + '/' + encodeURIComponent(j.rootId) + '?supportsAllDrives=true&fields=id', { trashed: true });
  }));
  const failed = [];
  results.forEach(function (r, i) { if (!r.ok) failed.push(st.jobs[i].srcName + ': ' + r.message); });
  if (failed.length === results.length) throw new Error('Could not move the copy to Trash: ' + failed[0]);
  removeTriggers_();
  clearJobState_();
  return { exists: false, deletedFailures: failed };
}

/** Keep the job running with the browser tab closed (uses time-trigger quota). */
function api_enableBackground() {
  const st = loadState_();
  if (!st || st.done) throw new Error('No running job.');
  removeTriggers_();
  ScriptApp.newTrigger('backgroundTick').timeBased().everyMinutes(1).create();
  st.bg = true;
  saveState_(st);
  return publicStatus_(st, false);
}

function api_disableBackground() {
  removeTriggers_();
  const st = loadState_();
  if (st) { st.bg = false; saveState_(st); }
  return publicStatus_(st, false);
}

/** Time-trigger entry point. */
function backgroundTick() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(3000)) return;             // the page (or a previous tick) is working
  try {
    const st = loadState_();
    if (!st || st.done || st.fatal) { removeTriggers_(); return; }
    runBatch_(st, CFG.BG_BUDGET_MS);
    if (st.done || st.fatal) removeTriggers_();
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------ the engine ----

// Guarantees every call makes at least one batch of progress, even if listing a
// huge folder already used up the time budget (otherwise a step could livelock).
let WORK_DONE_ = false;

/** Runs jobs in order (st.cur picks the active one) until the budget runs out. */
function runBatch_(st, budgetMs) {
  WORK_DONE_ = false;
  const deadline = Date.now() + budgetMs;
  let lastSave = Date.now();
  try {
    while (st.cur < st.jobs.length && !st.fatal && Date.now() < deadline) {
      const job = st.jobs[st.cur];
      if (!job.queue.length) { st.cur++; continue; }        // this job is done; move to the next

      const task = job.queue[job.queue.length - 1];
      let res;
      try {
        res = processFolder_(task, st, job, deadline);
      } catch (e) {
        if (e.fatalResult) {                     // e.g. the daily script-request cap was hit
          setFatal_(st, e.fatalResult);
          break;
        }
        if (e.permanent) {                       // e.g. no access to a subfolder
          addIssue_(job, 'Skipped a folder: ' + e.message);
          job.queue.pop();
          continue;
        }
        throw e;                                 // transient: page/trigger will retry
      }

      if (res.finished) {
        job.queue.pop();
        job.foldersDone++;
        job.skipped = (job.skipped || 0) + res.pre;
        res.children.forEach(function (c) { job.queue.push(c); });
      } else if (!res.timedOut && !st.fatal) {
        task[2] = res.progress > 0 ? 0 : task[2] + 1;
        if (task[2] >= CFG.MAX_FOLDER_ATTEMPTS) {
          addIssue_(job, 'Gave up on a folder after repeated errors (its contents were not fully copied).');
          job.queue.pop();
        }
      }
      if (Date.now() - lastSave > 3000) { saveState_(st); lastSave = Date.now(); }
    }
    if (st.cur >= st.jobs.length && !st.fatal && !st.done) finalize_(st);
  } finally {
    saveState_(st);
  }
}

/**
 * Handles one folder pair within one job. Idempotent: compares source with
 * what is already in the destination and only creates/copies what is missing.
 * Returns {finished, progress, timedOut, children, pre}.
 */
function processFolder_(task, st, job, deadline) {
  const srcId = task[0], dstId = task[1];
  const srcItems = listChildren_(srcId);
  const dstItems = listChildren_(dstId);

  const fileCounts = {};   // name -> how many non-folder items with that name already exist
  const folderIds = {};    // name -> [dest folder ids not yet matched]
  dstItems.forEach(function (it) {
    if (it.mimeType === FOLDER_MIME) (folderIds[it.name] = folderIds[it.name] || []).push(it.id);
    else fileCounts[it.name] = (fileCounts[it.name] || 0) + 1;
  });

  const srcFolders = [], toCopy = [];
  let matched = 0;         // source files that already exist in the destination
  srcItems.forEach(function (it) {
    if (it.mimeType === FOLDER_MIME) srcFolders.push(it);
    else if (it.mimeType === SHORTCUT_MIME) addIssue_(job, 'Shortcut not copied: ' + it.name);
    else if (isFiltered_(it, st.filter)) { job.filtered = (job.filtered || 0) + 1; }
    else if (fileCounts[it.name] > 0) { fileCounts[it.name]--; matched++; }   // already there
    else toCopy.push(it);
  });
  // Files this same job copied in earlier passes were not "there before we started".
  const pre = Math.max(0, matched - (task[3] || 0));

  let progress = 0, deferred = 0;
  const children = [];
  const outOfTime = function () { return WORK_DONE_ && Date.now() > deadline; };
  const out = function (finished, timedOut) {
    return { finished: finished, progress: progress, timedOut: !!timedOut, children: children, pre: pre };
  };

  // 1) subfolders: reuse existing ones, create the missing ones
  const toCreate = [];
  srcFolders.forEach(function (f) {
    const existing = (folderIds[f.name] || []).shift();
    if (existing) children.push([f.id, existing, 0, 0]);
    else toCreate.push(f);
  });
  for (let i = 0; i < toCreate.length; i += CFG.CONCURRENCY) {
    if (outOfTime()) return out(false, true);
    const chunk = toCreate.slice(i, i + CFG.CONCURRENCY);
    const res = fetchBatch_(chunk.map(function (f) { return folderReq_(f.name, dstId); }));
    WORK_DONE_ = true;
    res.forEach(function (r, k) {
      if (r.ok) { children.push([chunk[k].id, r.body.id, 0, 0]); progress++; }
      else if (r.fatal) setFatal_(st, r);
      else if (r.retryable) deferred++;
      else addIssue_(job, 'Folder not created: ' + chunk[k].name + ' - ' + r.message);
    });
    if (st.fatal) return out(false, false);
  }

  // 2) files: copy in parallel batches
  for (let i = 0; i < toCopy.length; i += CFG.CONCURRENCY) {
    if (outOfTime()) return out(false, true);
    const chunk = toCopy.slice(i, i + CFG.CONCURRENCY);
    const res = fetchBatch_(chunk.map(function (f) { return copyReq_(f, dstId); }));
    WORK_DONE_ = true;
    res.forEach(function (r, k) {
      if (r.ok) {
        job.files++; progress++; task[3] = (task[3] || 0) + 1;
        if (r.body && r.body.size) job.bytes = (job.bytes || 0) + Number(r.body.size);
      }
      else if (r.fatal) setFatal_(st, r);
      else if (r.retryable) deferred++;
      else addIssue_(job, 'Not copied: ' + chunk[k].name + ' - ' + r.message);
    });
    if (st.fatal) return out(false, false);
  }

  return deferred > 0 ? out(false, false) : out(true, false);
}

function finalize_(st) {
  st.done = true;
  st.finishedAt = Date.now();
  removeTriggers_();
  st.bg = false;
  st.jobs.forEach(function (job) {
    if (!job.issues.length) return;
    try {
      const text = 'Copy report for "' + job.srcName + '"' +
        (job.merge ? ' (merged into "' + job.destName + '")' : '') + '\n' +
        'Files copied: ' + job.files + '\n' +
        (job.merge ? 'Already there (skipped): ' + (job.skipped || 0) + '\n' : '') +
        'Items needing attention: ' + job.issues.length + (job.issuesOverflow ? '+' : '') + '\n\n' +
        job.issues.join('\n') + '\n';
      DriveApp.getFolderById(job.rootId).createFile('_copy-report.txt', text, MimeType.PLAIN_TEXT);
    } catch (e) { /* the report is a nicety; never fail the job over it */ }
  });
}

function setFatal_(st, r) {
  st.fatal = r.reason === 'urlfetchDailyQuota' ? r.message
    : 'Google stopped the copy (' + (r.reason || r.code) + '): ' + r.message +
      ' - free up Drive storage or wait for the daily limit to reset, then press Resume.';
}

function addIssue_(job, msg) {
  if (job.issues.indexOf(msg) !== -1) return;
  if (job.issues.length >= CFG.MAX_ISSUES_STORED) { job.issuesOverflow = true; return; }
  job.issues.push(msg);
}

// ------------------------------------------------------ Drive REST helpers ----

let TOKEN_ = null;
function token_() { return TOKEN_ || (TOKEN_ = ScriptApp.getOAuthToken()); }

function req_(method, url, bodyObj) {
  const r = {
    url: url,
    method: method,
    headers: { Authorization: 'Bearer ' + token_() },
    muteHttpExceptions: true
  };
  if (bodyObj) { r.contentType = 'application/json'; r.payload = JSON.stringify(bodyObj); }
  return r;
}

function copyReq_(item, dstId) {
  // `size` is requested for the running "data copied" counter - it's absent on native
  // Google Docs/Sheets/Slides copies (they don't have a byte size), which is fine.
  return req_('post', API + '/' + item.id + '/copy?supportsAllDrives=true&fields=id,name,size',
    { name: item.name, parents: [dstId] });
}

function folderReq_(name, parentId) {
  return req_('post', API + '?supportsAllDrives=true&fields=id,name',
    { name: name, mimeType: FOLDER_MIME, parents: [parentId] });
}

function getFile_(id, label) {
  const url = API + '/' + encodeURIComponent(id) + '?supportsAllDrives=true&fields=id,name,mimeType';
  const r = fetchBatch_([req_('get', url)])[0];
  if (!r.ok) {
    if (r.code === 404 || r.code === 403) {
      throw new Error('Cannot open the ' + label + '. Make sure it is shared with the Google account you are ' +
        'signed in with (open the link in this browser first to check).');
    }
    throw new Error('Drive error while opening the ' + label + ': ' + r.message);
  }
  return r.body;
}

function listChildren_(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const url = API +
      '?q=' + encodeURIComponent("'" + folderId + "' in parents and trashed=false") +
      '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType)') +
      '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const r = fetchBatch_([req_('get', url)])[0];
    if (!r.ok) {
      const e = new Error('Could not list a folder (' + r.message + ')');
      if (r.fatal) e.fatalResult = r; else e.permanent = !r.retryable;
      throw e;
    }
    (r.body.files || []).forEach(function (f) { out.push(f); });
    pageToken = r.body.nextPageToken || '';
  } while (pageToken);
  return out;
}

/**
 * Sends requests in parallel; retries rate-limit / 5xx / network failures with
 * exponential backoff. Returns one result per request, same order.
 */
function fetchBatch_(reqs) {
  const results = new Array(reqs.length);
  let pending = reqs.map(function (_, i) { return i; });
  for (let attempt = 0; attempt <= CFG.MAX_RETRIES && pending.length; attempt++) {
    if (attempt > 0) {
      Utilities.sleep(Math.min(32000, Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 500)));
    }
    let responses = null, netErr = null;
    bumpReqCounter_(pending.length);
    try {
      responses = UrlFetchApp.fetchAll(pending.map(function (i) { return reqs[i]; }));
    } catch (e) {
      netErr = e;
    }
    const bad = netErr ? classifyNetError_(netErr) : null;
    const next = [];
    pending.forEach(function (i, k) {
      const res = netErr ? bad : parse_(responses[k]);
      results[i] = res;
      if (res.retryable) next.push(i);
    });
    pending = next;
    if (bad && bad.dailyQuota) break;   // a daily cap - retrying again today won't help
  }
  return results;
}

/**
 * UrlFetchApp throws a plain JS exception (not an HTTP response) for a few
 * cases. The one that matters most is Apps Script's own daily request cap
 * ("Service invoked too many times for one day: urlfetch."), which a personal
 * Gmail account can hit on a very large copy. It only resets after about 24
 * hours, so unlike a normal network blip this must stop the job, not retry it.
 */
function classifyNetError_(e) {
  const msg = String((e && e.message) || e);
  if (/too many times for one day/i.test(msg)) {
    return {
      ok: false, code: 0, reason: 'urlfetchDailyQuota',
      message: 'This Google account has reached its daily limit for running scripts (a Google-wide limit shared ' +
        'by any Apps Script tool on this account, not specific to this copy). It resets roughly 24 hours after ' +
        'you started using scripts today. No files were lost or duplicated - come back after it resets and press Resume.',
      retryable: false, fatal: true, dailyQuota: true
    };
  }
  return { ok: false, code: 0, reason: 'network', message: msg, retryable: true, fatal: false };
}

function parse_(resp) {
  const code = resp.getResponseCode();
  let body = null;
  try { body = JSON.parse(resp.getContentText()); } catch (e) { /* not JSON */ }
  if (code >= 200 && code < 300) return { ok: true, code: code, body: body || {} };
  const err = (body && body.error) || {};
  const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.status || '';
  const fatal = /^(storageQuotaExceeded|dailyLimitExceeded|quotaExceeded)$/.test(reason);
  const retryable = !fatal && (code === 429 || code >= 500 ||
    (code === 403 && /^(rateLimitExceeded|userRateLimitExceeded)$/.test(reason)));
  return { ok: false, code: code, reason: reason, message: err.message || ('HTTP ' + code), retryable: retryable, fatal: fatal };
}

/** True if folderId is ancestorId itself or somewhere below it (walks up the parents). */
function isInsideOrSame_(folderId, ancestorId) {
  let cur = folderId;
  for (let i = 0; i < 100 && cur; i++) {
    if (cur === ancestorId) return true;
    const r = fetchBatch_([req_('get', API + '/' + encodeURIComponent(cur) + '?supportsAllDrives=true&fields=parents')])[0];
    if (!r.ok) return false;
    cur = r.body.parents && r.body.parents[0];
  }
  return false;
}

function parseId_(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/\/d\/([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : null;
}

// ------------------------------------------------------------------ state ----
// A property value is capped at ~9 KB, so the JSON is stored in 8 KB chunks.

function saveState_(st) {
  const props = PropertiesService.getUserProperties();
  const prevN = Number(props.getProperty('n') || 0);
  const chunks = JSON.stringify(st).match(/[\s\S]{1,8000}/g);
  const out = { n: String(chunks.length) };
  chunks.forEach(function (c, i) { out['s' + i] = c; });
  for (let i = chunks.length; i < prevN; i++) props.deleteProperty('s' + i);   // drop now-unused old chunks
  props.setProperties(out);
  // NOTE: this only ever touches its own 'n'/'s0..sN' keys - never deleteAllProperties(),
  // which would also wipe the separately-stored daily request counter (rc_day/rc_n).
}

/** Clears a job's saved state without touching the daily request counter. */
function clearJobState_() {
  const props = PropertiesService.getUserProperties();
  const n = Number(props.getProperty('n') || 0);
  props.deleteProperty('n');
  for (let i = 0; i < n; i++) props.deleteProperty('s' + i);
}

function loadState_() {
  const props = PropertiesService.getUserProperties();
  const n = Number(props.getProperty('n'));
  if (!n) return null;
  let json = '';
  for (let i = 0; i < n; i++) json += props.getProperty('s' + i);
  return migrate_(JSON.parse(json));
}

/** A job saved before multi-folder support (no `jobs` array) is wrapped into the current shape. */
function migrate_(st) {
  if (st && !st.jobs) {
    st.jobs = [{
      srcName: st.srcName, merge: !!st.merge, destName: st.destName || null,
      rootId: st.rootId, rootUrl: st.rootUrl, queue: st.queue,
      files: st.files || 0, skipped: st.skipped || 0, foldersDone: st.foldersDone || 0,
      issues: st.issues || [], issuesOverflow: !!st.issuesOverflow
    }];
    st.cur = 0;
    delete st.srcName; delete st.merge; delete st.destName; delete st.rootId; delete st.rootUrl;
    delete st.queue; delete st.files; delete st.skipped; delete st.foldersDone;
    delete st.issues; delete st.issuesOverflow;
  }
  return st;
}

/**
 * A running count of Drive API requests made today (every UrlFetchApp call, including
 * retries), so the page can show how close the account is to Apps Script's daily
 * UrlFetch cap (20,000/day on a personal account, 100,000/day on Workspace). Stored
 * separately from the job state so it survives across jobs and resets are counted from
 * UTC midnight - a simple approximation of Google's own ~24h-rolling reset, not an exact
 * match, and is labelled as such in the UI.
 */
function bumpReqCounter_(n) {
  try {
    const props = PropertiesService.getUserProperties();
    const day = new Date().toISOString().slice(0, 10);
    const count = (props.getProperty('rc_day') === day ? Number(props.getProperty('rc_n') || 0) : 0) + n;
    props.setProperty('rc_day', day);
    props.setProperty('rc_n', String(count));
  } catch (e) { /* the counter is a nicety; never fail a request over it */ }
}

function getReqCounter_() {
  try {
    const props = PropertiesService.getUserProperties();
    const day = new Date().toISOString().slice(0, 10);
    return props.getProperty('rc_day') === day ? Number(props.getProperty('rc_n') || 0) : 0;
  } catch (e) { return 0; }
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backgroundTick') ScriptApp.deleteTrigger(t);
  });
}

function publicStatus_(st, busy) {
  if (!st) return { exists: false, reqUsedToday: getReqCounter_() };
  const jobs = st.jobs;
  const curIdx = Math.min(st.cur, jobs.length - 1);
  const curJob = jobs[curIdx];

  let files = 0, skipped = 0, filtered = 0, bytes = 0, foldersDone = 0, queueLen = 0, issueCount = 0, issuesOverflow = false;
  const issues = [];
  jobs.forEach(function (j) {
    files += j.files;
    skipped += j.skipped || 0;
    filtered += j.filtered || 0;
    bytes += j.bytes || 0;
    foldersDone += j.foldersDone;
    queueLen += j.queue.length;
    issueCount += j.issues.length;
    if (j.issuesOverflow) issuesOverflow = true;
    j.issues.forEach(function (m) {
      if (issues.length < 25) issues.push(jobs.length > 1 ? '[' + j.srcName + '] ' + m : m);
    });
  });

  const stoppedOrDone = !!st.done || !!st.fatal;
  const anyMerge = jobs.some(function (j) { return j.merge; });

  return {
    exists: true,
    done: !!st.done,
    fatal: st.fatal || null,
    busy: !!busy,
    bg: !!st.bg,
    jobCount: jobs.length,
    jobsDone: Math.min(st.cur, jobs.length),   // jobs fully finished so far (equals jobCount once done)
    srcName: curJob.srcName,                   // the job currently active (or last one, once done)
    merge: !!curJob.merge,
    destName: curJob.destName || null,
    rootUrl: curJob.rootUrl,
    roots: jobs.map(function (j) { return { name: j.srcName, url: j.rootUrl }; }),
    files: files,
    skipped: skipped,
    filtered: filtered,
    bytes: bytes,
    foldersDone: foldersDone,
    queueLen: queueLen,
    issueCount: issueCount,
    issuesOverflow: issuesOverflow,
    issues: issues,
    canDelete: stoppedOrDone && !anyMerge,
    reqUsedToday: getReqCounter_(),
    startedAt: st.startedAt,
    finishedAt: st.finishedAt || null
  };
}
