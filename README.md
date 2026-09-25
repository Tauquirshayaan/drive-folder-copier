# Drive Folder Copier

A Google Apps Script web app that copies a shared Google Drive folder — including every subfolder and file inside it — into your own Drive. Google Drive has no built-in "copy folder" button for shared folders; this tool does it for you, with resumable progress, live stats, file-type filters, a folder preview, and an undo option.

Runs entirely inside your own Google account. No data passes through any third-party server — every file is copied Drive-to-Drive by Google's own servers.

## Features

- Copy one or several shared folders in a single job (paste multiple links)
- Preview a folder's file tree before copying anything
- Filter out file types you don't want (videos, images, audio, PDFs, Google Docs/Sheets/Slides, archives, or custom extensions)
- Merge a copy into an existing folder of yours, or create a fresh copy
- Pause, resume, and run in the background (survives closing the tab)
- Resumable — if it stops partway through, press Resume and it picks up where it left off, without re-copying anything
- Live stats: files copied, skipped, filtered, folders done, approximate bytes copied, approximate files/min
- Live quota display: your Apps Script daily request usage and your real Google Drive storage usage
- "Delete this copy" button to undo a finished job (moves the copied folder to Trash — recoverable, never a permanent delete)
- A `_copy-report.txt` file is written into the destination folder if anything couldn't be copied, listing exactly what and why

## How it works

The app runs as an Apps Script **web app** tied to your own Google account. When you open it, it asks you to sign in and grant it permission to use Drive. From then on, all the copying happens through Google's own Drive API, driven by your browser polling the script every few seconds — the actual file bytes never leave Google's infrastructure.

Because Apps Script imposes execution time limits on a single run, the app works in short steps (a few seconds each) and saves its progress after every step, so a large folder (thousands of files) can be copied over many steps without ever losing progress.

## Setup

You only need a Google account. No billing, no external hosting, nothing to install locally.

### 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Rename the project (top left) to something like `Drive Folder Copier`.
3. In the left sidebar, click the gear icon (**Project Settings**) and check **"Show appsscript.json manifest file in editor"**.

### 2. Add the project files

You need three files in the project, matching the three files in this repo:

| Repo file | Apps Script project |
|---|---|
| `Code.gs` | the default `Code.gs` file — replace its contents |
| `Index.html` | add a new **HTML** file named `Index` (via **File → New → HTML**) — replace its contents |
| `appsscript.json` | the manifest file you enabled in step 1 — replace its contents |

For each one: open the matching file in the Apps Script editor, select all existing content, delete it, and paste in the contents of the file from this repo. Save (Ctrl/Cmd+S) after each.

> `appsscript.json` sets the OAuth scopes the app needs (Drive access, external requests for the Drive REST API, and script triggers for background mode) and configures the web app to run as **you**, accessible only to **you** (`executeAs: USER_ACCESSING`, `access: MYSELF`). You can change `access` later if you want to let others use your deployment — see [Sharing the app with others](#sharing-the-app-with-others).

### 3. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description**: anything, e.g. `v1`
   - **Execute as**: **Me**
   - **Who has access**: **Only myself** (or **Anyone with the link** if you want others to use it — see below)
4. Click **Deploy**.
5. Click **Authorize access**, choose your Google account, and click through the "Google hasn't verified this app" warning:
   - Click **Advanced**
   - Click **Go to Drive Folder Copier (unsafe)**
   - Review the permissions (it will ask for full Drive access, since it needs to read and write folders across your Drive) and click **Allow**

   This warning appears only because the project isn't published on the Play Store — it's normal for a personal script and is safe to accept since you wrote/reviewed the code yourself.
6. Copy the **Web app URL** shown after deployment. That's your app.

### 4. Getting the URL again later (without redeploying)

You don't need to create a new deployment every time you edit the code. To push code edits to your existing URL:

- Click **Deploy → Manage deployments**
- Click the pencil (edit) icon on your existing deployment
- Under **Version**, choose **New version**, then click **Deploy**

This updates the same web app URL with your latest code. To find the URL again later, go to **Deploy → Manage deployments** and it's listed there, or check **Extensions → Apps Script → Deploy → Manage deployments** from any Google Sheet/Doc if you attached it to one.

## Usage

1. Open your web app URL.
2. Paste one or more shared Google Drive folder links into the box, one per line (or comma-separated). Each must be a folder link you have at least view access to, e.g. `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz`.
3. (Optional) Click **Preview** to see the folder's file tree before copying anything — useful for checking you've got the right folder and roughly how large it is.
4. (Optional) Open **Filters** and check any file types you want to skip (videos, images, audio, PDFs, Google Docs, archives), or type custom extensions to exclude.
5. (Optional) Set a **Destination** folder — leave blank to copy into the root of your My Drive. Check **Merge into destination** to copy directly into an existing folder of yours instead of creating a new copy folder (only allowed with a single source folder).
6. (Optional) Change the **suffix** appended to the copied folder's name (default is ` (Copy)`).
7. Click **Start**. The job runs in short automatic steps; you'll see live progress — files copied, filtered, folders done, approximate bytes and files/min — updating every few seconds.
8. You can **Pause**/**Resume** at any time, or click **Run in background** to let it keep going via a time-based trigger even if you close the browser tab (reopen the app later to check progress).
9. When finished, you'll see a summary with a link to each copied folder. If anything couldn't be copied, a `_copy-report.txt` file is added to the destination folder listing what and why.
10. If you want to undo a finished copy, click **Delete this copy** — this moves the folder(s) the app created to Trash (recoverable from Drive's Trash for 30 days). This button is unavailable for merge jobs, since nothing new was created that's safe to delete.

### The quota bar

At the top of the app you'll see two live numbers:

- **Requests used today** — how many Apps Script/Drive API calls the script has made today. Apps Script enforces a daily cap on external requests (higher for Google Workspace accounts than personal `@gmail.com` accounts); this bar lets you see how close you are before it becomes a problem. Use the toggle to tell it which kind of account you have, so the bar's percentage is accurate.
- **Drive storage used** — your actual Google Drive storage usage and limit, pulled live from Drive itself.

There is no literal "transfer speed in MB/s" shown, because Drive-to-Drive copies never pass bytes through the script or your browser — Google's servers copy the file directly, so a bytes-per-second number wouldn't reflect anything real. The approximate bytes-copied and files/min figures are shown instead.

## Error handling

The app detects and clearly reports:

- **Google Drive storage full** (`storageQuotaExceeded`) — the job stops with a message telling you to free up space or wait, then press Resume.
- **Google's own daily/quota limits** on your account.
- **Apps Script's daily request limit** being hit — stops with a clear message rather than failing silently.
- **Bad input** — a link that isn't a folder, a folder you don't have access to, a destination that's inside the source, invalid merge/filter combinations, or too many source folders at once — all caught before anything is copied.
- **Per-file/per-folder problems** (a single file you don't have permission to copy, a subfolder that can't be listed, a Drive shortcut that can't be copied) are logged as issues in the final report but don't stop the rest of the job.
- **Temporary problems** (rate limiting, server errors, brief network issues) are retried automatically with backoff and are invisible unless they persist.

**Known limitations** (not yet handled specially): if you revoke the app's Drive access partway through a job, or delete the destination folder itself (not a subfolder) mid-copy, the app doesn't yet show one clear message for those specific cases — it degrades into a batch of generic per-file errors instead. Worth knowing if you hit either scenario.

## Sharing the app with others

If you want someone else to be able to use your deployment:

1. **Deploy → Manage deployments → edit → Who has access → Anyone with the link (or Anyone with a Google account)**.
2. Each person who opens the link authorizes it with their **own** Google account and their own Drive permissions — they can only copy folders they themselves have access to, into their own Drive. Nobody sees or touches your Drive.

Since the script runs `executeAs: USER_ACCESSING`, this is safe to share — every visitor acts as themselves, never as you.

## Project structure

```
Code.gs         Server-side logic: Drive API calls, job/queue state, retries, error handling
Index.html      Client UI: form, live progress, filters, preview, quota display
appsscript.json Project manifest: OAuth scopes and web app deployment settings
```

## Limitations

- Google Drive Shortcuts are not copied (not supported by the Drive API's copy operation) — they're listed as skipped.
- Very large folders (tens of thousands of items) will take correspondingly longer, since Apps Script limits how much work can happen per step, but the job will complete across enough steps as long as you leave the tab open or use background mode.
- The daily Apps Script request quota is shared across your entire Google account's scripts, not just this app.
