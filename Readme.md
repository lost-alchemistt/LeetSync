# LeetSync — Architecture & Flow Documentation

> A Chrome extension that automatically pushes your accepted LeetCode submissions to a GitHub repository.

---

## Table of Contents

1. [Overview](#overview)
2. [File Structure](#file-structure)
3. [How It Works — End to End](#how-it-works--end-to-end)
4. [Flow Breakdown](#flow-breakdown)
   - [Step 1: Detecting a Submission](#step-1-detecting-a-submission)
   - [Step 2: Extracting the Submission ID](#step-2-extracting-the-submission-id)
   - [Step 3: Fetching the Session Cookie](#step-3-fetching-the-session-cookie)
   - [Step 4: Fetching Code via GraphQL](#step-4-fetching-code-via-graphql)
   - [Step 5: Pushing to GitHub](#step-5-pushing-to-github)
5. [Architecture Diagram](#architecture-diagram)
6. [Key Design Decisions](#key-design-decisions)
7. [Permissions Explained](#permissions-explained)
8. [Configuration](#configuration)

---

## Overview

LeetSync sits quietly in the background of your browser. The moment you submit a solution on LeetCode and it gets accepted, the extension:

1. Detects the successful submission via a network request listener
2. Fetches your actual code using LeetCode's GraphQL API
3. Pushes the code as a file to your GitHub repository — automatically

No manual copying, no scripts to run. It just works.

---

## File Structure

```
leetsync/
├── manifest.json        # Extension configuration & permissions
├── background.js        # Core logic (service worker)
├── config.js            # Your secrets (GitHub token, repo name) — gitignored
└── config.example.js    # Template for config.js
```

---

## How It Works — End to End

```
User clicks "Submit" on LeetCode
        │
        ▼
LeetCode runs your code & polls /submissions/detail/{id}/check/
        │
        ▼
background.js intercepts that network request (webRequest listener)
        │
        ▼
Extract submission ID from the URL
        │
        ▼
Read LEETCODE_SESSION cookie from browser
        │
        ▼
POST to leetcode.com/graphql → get actual code + title + language
        │
        ▼
Is status "Accepted"? ──No──▶ Stop, do nothing
        │ Yes
        ▼
Check if file already exists in GitHub repo (GET /contents/{path})
        │
        ├── File exists? → include SHA in request (required for updates)
        │
        ▼
PUT to GitHub API → create or update the file
        │
        ▼
Solution saved to GitHub ✓
```

---

## Flow Breakdown

### Step 1: Detecting a Submission

**File:** `background.js` — `chrome.webRequest.onCompleted` listener

**What happens:**

When you hit "Submit" on LeetCode, the page starts polling a URL that looks like:

```
https://leetcode.com/submissions/detail/1234567890/check/
```

LeetCode calls this endpoint repeatedly until judging is done. The extension listens to ALL completed network requests matching this URL pattern using Chrome's `webRequest` API.

```
manifest.json declares: "host_permissions": ["https://leetcode.com/*"]
                                                        ↓
background.js listens:  urls: ["https://leetcode.com/submissions/detail/*/check/"]
```

> **Why `/check/` and not the submit button click?**
> The extension can't hook into DOM events directly from the service worker. Intercepting the network request is more reliable — it fires only when LeetCode actually finishes judging.

---

### Step 2: Extracting the Submission ID

**File:** `background.js` — regex on `details.url`

The URL contains the submission ID, which is needed to query the GraphQL API:

```
https://leetcode.com/submissions/detail/1234567890/check/
                                         ^^^^^^^^^^
                                         submission ID
```

A regex extracts it:

```js
const match = details.url.match(/submissions\/detail\/(\d+)\/check/);
const submissionId = match[1]; // "1234567890"
```

---

### Step 3: Fetching the Session Cookie

**File:** `background.js` — `getLeetCodeSession()`

LeetCode's GraphQL API requires authentication. Rather than asking the user to paste their token, the extension reads the `LEETCODE_SESSION` cookie that's already in the browser (because the user is logged in).

```
chrome.cookies.get({ url: 'https://leetcode.com', name: 'LEETCODE_SESSION' })
```

This is why `"cookies"` is declared in `manifest.json` permissions.

> **Security note:** The cookie is only read locally and only sent to `leetcode.com`. It is never stored or sent anywhere else.

---

### Step 4: Fetching Code via GraphQL

**File:** `background.js` — `fetchSubmissionDetails()`

This is the most important step. The `/check/` URL **does not contain the actual code** — it only returns verdict info (status, runtime, memory). To get the real code, the extension queries LeetCode's GraphQL endpoint:

```
POST https://leetcode.com/graphql/
```

With this query:

```graphql
query submissionDetails($submissionId: Int!) {
  submissionDetails(submissionId: $submissionId) {
    statusCode     # 10 = Accepted
    lang { name }  # "python3", "cpp", etc.
    code           # The actual submitted code
    question {
      titleSlug    # e.g. "two-sum"
      title        # e.g. "Two Sum"
    }
  }
}
```

The session cookie is passed as a request header for authentication. The response comes back as JSON with all the data needed to save the file.

---

### Step 5: Pushing to GitHub

**File:** `background.js` — `pushToGitHub()`

Once the code is retrieved and confirmed as "Accepted" (`statusCode === 10`), it gets pushed to GitHub using the GitHub Contents API:

**5a. Determine the file path**

The language is mapped to a file extension:

```
python3  →  two-sum.py
cpp      →  two-sum.cpp
java     →  two-sum.java
```

**5b. Check if file already exists**

```
GET https://api.github.com/repos/{owner}/{repo}/contents/{path}
```

If the file exists, GitHub returns a `sha` field. This SHA must be included in the update request — otherwise GitHub rejects it as a conflict.

**5c. Create or update the file**

```
PUT https://api.github.com/repos/{owner}/{repo}/contents/{path}

Body:
{
  "message": "Solved two-sum",
  "content": "<base64 encoded code>",
  "sha": "<only included if file already exists>"
}
```

The code is Base64-encoded before sending (GitHub API requirement). The encoding handles Unicode characters safely using `btoa(unescape(encodeURIComponent(code)))`.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     Chrome Browser                       │
│                                                         │
│  ┌─────────────────┐       ┌──────────────────────────┐ │
│  │   LeetCode Tab  │       │   background.js          │ │
│  │                 │       │   (Service Worker)       │ │
│  │  User submits   │──────▶│                          │ │
│  │  solution       │  URL  │  webRequest.onCompleted  │ │
│  │                 │ event │  listener fires          │ │
│  └─────────────────┘       └──────────┬───────────────┘ │
│                                       │                  │
│                            ┌──────────▼───────────────┐ │
│                            │  chrome.cookies.get()    │ │
│                            │  reads LEETCODE_SESSION  │ │
│                            └──────────┬───────────────┘ │
└───────────────────────────────────────┼─────────────────┘
                                        │
               ┌────────────────────────┼──────────────────────┐
               │                        │                       │
               ▼                        ▼                       ▼
    ┌──────────────────┐    ┌───────────────────────┐  ┌──────────────────┐
    │  leetcode.com    │    │  leetcode.com/graphql │  │  api.github.com  │
    │  /check/ API     │    │                       │  │                  │
    │  (verdict only)  │    │  submissionDetails    │  │  PUT /contents/  │
    │                  │    │  query → returns code │  │  two-sum.py      │
    └──────────────────┘    └───────────────────────┘  └──────────────────┘
```

---

## Key Design Decisions

| Decision | Reason |
|---|---|
| Listen to `/check/` URL instead of the submit button | Service workers can't access the DOM; network interception is more reliable |
| Use GraphQL `submissionDetails` instead of `/check/` response | The `/check/` response does NOT include the actual code — only verdict info |
| Read `LEETCODE_SESSION` cookie instead of asking the user | The user is already logged in; avoids extra setup steps |
| Include `sha` when updating a file | GitHub's API requires it to prevent accidental overwrites — acts like an optimistic lock |
| Use `btoa(unescape(encodeURIComponent(code)))` | Plain `btoa()` throws on non-ASCII characters (e.g. comments in other languages) |
| Manifest V3 with `"type": "module"` | Allows ES module `import` syntax in the service worker for clean config separation |

---

## Permissions Explained

| Permission | Why it's needed |
|---|---|
| `webRequest` | Listen to outgoing network requests from the LeetCode tab |
| `cookies` | Read the `LEETCODE_SESSION` cookie for authenticated GraphQL calls |
| `host_permissions: leetcode.com` | Required to intercept LeetCode network traffic |
| `host_permissions: api.github.com` | Required to make GitHub API calls from the service worker |

---

## Configuration

Copy `config.example.js` to `config.js` and fill in your values:

```js
export const secrets = {
  GITHUB_TOKEN: "ghp_xxxxxxxxxxxx",  // Personal Access Token with repo scope
  REPO_OWNER: "your-username",
  REPO_NAME: "Leetcode-Submissions"
};
```

**How to get a GitHub token:**
1. Go to GitHub → Settings → Developer Settings → Personal Access Tokens
2. Generate a new token with the `repo` scope (read + write access to repositories)
3. Paste it into `config.js`

> `config.js` is intentionally excluded from version control. Never commit your token.