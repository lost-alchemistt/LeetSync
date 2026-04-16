import { secrets } from './config.js';

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.url.includes('/check/')) {
      const response = await fetch(details.url);
      const data = await response.json();

      if (data.status_msg === 'Accepted') {
        await pushToGitHub(data);
      }
    }
  },
  { urls: ["https://leetcode.com/submissions/detail/*/check/"] }
);

async function pushToGitHub(data) {
  const fileExt = getExtension(data.lang);
  const path = `${data.title_slug}.${fileExt}`;
  const url = `https://api.github.com/repos/${secrets.REPO_OWNER}/${secrets.REPO_NAME}/contents/${path}`;

  // 1. Check if file exists to get SHA
  const getFile = await fetch(url, {
    headers: { 'Authorization': `token ${secrets.GITHUB_TOKEN}` }
  });
  
  let sha = null;
  if (getFile.status === 200) {
    const existingFile = await getFile.json();
    sha = existingFile.sha;
  }

  // 2. Push/Update file
  await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${secrets.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `Solved ${data.title_slug}`,
      content: btoa(data.code), // Base64 encoding
      sha: sha // Only needed if updating
    })
  });
}

function getExtension(lang) {
  const map = { 
    'cpp': 'cpp', 
    'python3': 'py', 
    'python': 'py',
    'java': 'java', 
    'javascript': 'js', 
    'typescript': 'ts' 
  };
  return map[lang] || 'txt';
}