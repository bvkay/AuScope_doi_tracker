#!/usr/bin/env node
/** Refresh the public repository snapshot used by the Software Registry. */
const fs = require('fs');
const path = require('path');

const ORG = 'AuScope';
const OUTPUT = path.join(__dirname, '..', 'data', 'github-software.json');

function normalise(repo) {
  return {
    name: repo.name || '',
    fullName: repo.full_name || '',
    url: repo.html_url || '',
    description: repo.description || '',
    homepage: repo.homepage || '',
    language: repo.language || '',
    topics: repo.topics || [],
    license: repo.license ? (repo.license.spdx_id || repo.license.name || '') : '',
    archived: Boolean(repo.archived),
    fork: Boolean(repo.fork),
    stars: Number(repo.stargazers_count) || 0,
    forks: Number(repo.forks_count) || 0,
    openIssues: Number(repo.open_issues_count) || 0,
    createdAt: repo.created_at || '',
    updatedAt: repo.updated_at || '',
    pushedAt: repo.pushed_at || ''
  };
}

async function fetchRepositories() {
  const records = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/orgs/${ORG}/repos?type=public&per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AuScope-DOI-Tracker' }
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    const batch = await response.json();
    records.push(...batch);
    if (batch.length < 100) break;
  }
  return records;
}

async function run() {
  const input = process.argv[2];
  const repositories = input
    ? JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'))
    : await fetchRepositories();
  const records = repositories
    .filter(function(repo) { return repo.name !== '.github'; })
    .map(normalise)
    .sort(function(a, b) { return a.name.localeCompare(b.name); });
  fs.writeFileSync(OUTPUT, JSON.stringify({
    metadata: {
      generated: new Date().toISOString(),
      organisation: ORG,
      organisationUrl: `https://github.com/${ORG}`,
      source: `https://api.github.com/orgs/${ORG}/repos`,
      excluded: ['.github'],
      recordCount: records.length
    },
    records: records
  }, null, 2) + '\n');
  console.log(`Saved ${records.length} AuScope repositories to ${OUTPUT}`);
}

run().catch(function(error) {
  console.error(error.message);
  process.exitCode = 1;
});
