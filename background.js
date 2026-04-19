import { secrets } from './config.js';

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.url.includes('/submissions/detail/') && details.url.includes('/check/')) {
      // Extract submission ID from URL
      // URL pattern: /submissions/detail/1234567890/check/
      const match = details.url.match(/submissions\/detail\/(\d+)\/check/);
      if (!match) return;

      const submissionId = match[1];

      // The /check/ endpoint only returns verdict info, NOT the code.
      // We need to call LeetCode's GraphQL API with submissionDetails to get the actual code.
      const leetSession = await getLeetCodeSession();
      if (!leetSession) {
        console.error('LeetSync: Could not retrieve LeetCode session cookie.');
        return;
      }

      const submissionData = await fetchSubmissionDetails(submissionId, leetSession);
      if (!submissionData) return;

      if (submissionData.statusCode === 10) { // 10 = Accepted
        await pushToGitHub(submissionData);
      }
    }
  },
  { urls: ["https://leetcode.com/submissions/detail/*/check/"] }
);

// Retrieve the LEETCODE_SESSION cookie from the browser
async function getLeetCodeSession() {
  return new Promise((resolve) => {
    chrome.cookies.get(
      { url: 'https://leetcode.com', name: 'LEETCODE_SESSION' },
      (cookie) => resolve(cookie ? cookie.value : null)
    );
  });
}

// Use LeetCode GraphQL API to get submission details including the actual code
async function fetchSubmissionDetails(submissionId, session) {
  const query = `
    query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        statusCode
        lang {
          name
          verboseName
        }
        code
        question {
          titleSlug
          title
        }
        runtime
        memory
      }
    }
  `;

  try {
    const response = await fetch('https://leetcode.com/graphql/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `LEETCODE_SESSION=${session}`,
      },
      body: JSON.stringify({
        query,
        variables: { submissionId: parseInt(submissionId) }
      })
    });

    const json = await response.json();
    return json?.data?.submissionDetails || null;
  } catch (err) {
    console.error('LeetSync: Failed to fetch submission details:', err);
    return null;
  }
}

async function pushToGitHub(data) {
  const langName = data.lang?.name || 'txt';
  const fileExt = getExtension(langName);
  const titleSlug = data.question?.titleSlug || 'unknown';
  const path = `${titleSlug}.${fileExt}`;
  const url = `https://api.github.com/repos/${secrets.REPO_OWNER}/${secrets.REPO_NAME}/contents/${path}`;

  // 1. Check if file exists to get SHA (needed for updates)
  const getFile = await fetch(url, {
    headers: { 'Authorization': `token ${secrets.GITHUB_TOKEN}` }
  });

  let sha = null;
  if (getFile.status === 200) {
    const existingFile = await getFile.json();
    sha = existingFile.sha;
  }

  // 2. Push/Update file
  const body = {
    message: `Solved ${titleSlug}`,
    content: btoa(unescape(encodeURIComponent(data.code))), // Safe Base64 for unicode
  };
  if (sha) body.sha = sha; // Only include sha if updating

  const pushResponse = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${secrets.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });

  if (pushResponse.ok) {
    console.log(`LeetSync: Successfully pushed ${titleSlug} to GitHub!`);
  } else {
    const err = await pushResponse.json();
    console.error('LeetSync: GitHub push failed:', err);
  }
}

function getExtension(lang) {
  const map = {
    'cpp': 'cpp',
    'python3': 'py',
    'python': 'py',
    'java': 'java',
    'javascript': 'js',
    'typescript': 'ts',
    'golang': 'go',
    'rust': 'rs',
    'c': 'c',
    'csharp': 'cs',
    'kotlin': 'kt',
    'swift': 'swift',
    'ruby': 'rb',
    'scala': 'scala',
  };
  return map[lang] || 'txt';
}