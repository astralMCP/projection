/**
 * Build packages/harness/test/fixtures/search-corpus.json — the offline
 * search-retrieval corpus — from recorded eval transcripts plus hand-written
 * and generated queries. Run once from the repo root:
 *
 *   find .claude/worktrees/*\/.claude/hillclimb -name '*.json' -size +20k > /tmp/files.txt
 *   pnpm --filter @astral-mcp/harness exec unrun \
 *     ../../.claude/hillclimb/multi-server/explore/offline-search/build-corpus.ts /tmp/files.txt
 *
 * Recorded transcripts are local only (raw/ is git-ignored), so this script
 * is provenance, not something CI runs. No model calls.
 *
 * Labels. A recorded query's gold set is the in-scope tools the model went on
 * to describe or call without error before its next search, intersected
 * with the tools that serve the query's intent (INTENT rules below, written
 * from the catalogs, not from the ranker). When the model used none of the
 * intent tools, the intent set is the gold. A query no intent rule matches
 * ("CSV export", "widgets", "grace@example.com order") is a CONTENT query:
 * the model searched the catalog for data, which no tool ranking can answer;
 * those are kept apart and counted, never scored.
 *
 * Split: cases are grouped by their sorted token set (so "list files
 * directory" and "list directory files", and a recorded query and its
 * lifted twin, share a split), and each group goes to train with
 * probability 0.6 under a fixed seed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seededRandom,
  syntheticQueries,
} from '../../../../../packages/harness/src/eval/offline/synthetic.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../../../packages/harness/test/fixtures/search-corpus.json');
const SEED = 20_261_030;
const TRAIN_FRACTION = 0.6;

type Surface =
  'github' | 'fs' | 'mongo' | 'multi' | 'multi:github' | 'multi:fs' | 'multi:mongo' | 'synthetic';
type Box = 'github' | 'fs' | 'mongo';

interface Case {
  id: string;
  surface: Surface;
  query: string;
  gold: string[];
  source: 'recorded' | 'recorded-lifted' | 'handwritten' | 'generated';
  /** How many times models issued this query on this surface (recorded only). */
  seen?: number;
  /** recorded: whether the gold came from the model's own follow-up ('used') or the intent rule alone. */
  label?: 'used' | 'intent';
  paraphrase?: boolean;
  split?: 'train' | 'test';
}

// ---------------------------------------------------------------------------
// Intent rules: query words → the tools that serve them, per catalog
// ---------------------------------------------------------------------------

type Rule = [RegExp, string[]];

const READ_FS = ['read_text_file', 'read_file', 'read_multiple_files'];
const LIST_FS = ['list_directory', 'list_directory_with_sizes'];

const FS_RULES: Rule[] = [
  [/\b(image|media|picture|png|logo)\b/, ['read_media_file']],
  [/\bappend\b/, ['edit_file', 'write_file']],
  [/\b(edit|replace|diff|patch)\b/, ['edit_file']],
  [/\b(write|save|overwrite)\b/, ['write_file']],
  [/\b(read|content|contents|view|head|tail|lines|cat)\b/, READ_FS],
  [/\b(move|rename|copy)\b/, ['move_file']],
  [/\b(mkdir|folder)\b|\bcreate directory\b|\bdirectory create\b/, ['create_directory']],
  [/\b(tree|structure|recursive)\b/, ['directory_tree']],
  [/\bsizes?\b|\bbiggest\b|\blargest\b/, ['list_directory_with_sizes', 'get_file_info']],
  [/\b(stat|metadata|info|modified|modification|exists)\b/, ['get_file_info']],
  [/\ballowed\b/, ['list_allowed_directories']],
  [/\b(search|find|glob|pattern)\b/, ['search_files']],
  [/\b(list|listing|ls)\b|\bdirectory\b/, LIST_FS],
];

const GH_RULES: Rule[] = [
  [/\breply\b|\breview comments?\b/, ['add_reply_to_pull_request_comment', 'pull_request_read']],
  [/\brequest changes\b|\breview\b/, ['pull_request_review_write']],
  [/\bcomment/, ['add_issue_comment']],
  [/\bmerge\b/, ['merge_pull_request']],
  [
    /\b(pull requests?|prs?)\b.*\b(close|update)\b|\b(close|update)\b.*\bpull request/,
    ['update_pull_request'],
  ],
  [
    /\b(check runs?|checks|check run|status|files|diff|details|139)\b.*\b(pull request|pr)\b|\b(pull request|pr)\b.*\b(check|checks|status|files|diff|details|read|get|139)\b/,
    ['pull_request_read'],
  ],
  [/\bsearch pull requests?\b/, ['search_pull_requests']],
  [/\b(pull requests?|prs)\b/, ['list_pull_requests', 'search_pull_requests']],
  [
    /\b(create|update|close|write) issue|issue (create|update|write)\b|\blabels? (to )?issue|\bissues? .*update label|add label/,
    ['issue_write'],
  ],
  [/\bissue (get|read)\b|\bissue read\b|\bget issue\b/, ['issue_read']],
  [/\bsearch issues\b|\bissues search\b/, ['search_issues']],
  [/\bissues?\b/, ['list_issues', 'search_issues']],
  [/\bcreate branch|branch create\b/, ['create_branch']],
  [/\bbranch(es)?\b/, ['list_branches']],
  [/\bstarred\b/, ['list_starred_repositories']],
  [/\bstar\b/, ['star_repository', 'list_starred_repositories']],
  [/\bnotifications?\b/, ['list_notifications']],
  [/\bworkflow|\bre-?run\b|\bfailed jobs\b/, ['actions_run_trigger']],
  [/\bdependabot\b/, ['list_dependabot_alerts']],
  [/\bget me\b/, ['get_me']],
  [/\b(list|search) repositor|\brepositories\b/, ['search_repositories']],
  [/\bcheck runs?\b|\bchecks\b/, ['pull_request_read']],
  [/\b(readme|contents? file|get contents)\b|\bfile\b.*\bcontents?\b/, ['get_file_contents']],
  [
    /\b(tree|files directory|directory|repository contents?)\b/,
    ['get_repository_tree', 'get_file_contents'],
  ],
  [/\breleases?\b/, ['list_releases', 'get_latest_release']],
  [/\btags?\b/, ['list_tags']],
  [/\bfork\b/, ['fork_repository']],
  [/\bsearch code\b/, ['search_code']],
];

const MONGO_RULES: Rule[] = [
  [/\bexplain\b/, ['explain']],
  [/\bcount\b/, ['count']],
  [/\baggregat/, ['aggregate', 'aggregate-db']],
  [/\bdrop collection\b|\bdelete collection\b|\bcollection delete\b/, ['drop-collection']],
  [/\b(delete|remove)\b/, ['delete-many']],
  [/\brename\b/, ['rename-collection']],
  [/\bupsert\b|\bupdate\b|\btier\b|\breplace\b/, ['update-many']],
  [/\b(insert|add)\b/, ['insert-many']],
  [/\bcreate index\b|\bindex create\b|\bindex create add\b/, ['create-index']],
  [/\bindex(es)?\b/, ['collection-indexes', 'create-index']],
  [/\b(schema|fields)\b/, ['collection-schema']],
  [
    /\bcollections\b.*\b(list|database)\b|\blist collections\b|\bcollections list\b/,
    ['list-collections'],
  ],
  [/\bdatabases\b/, ['list-databases', 'list-collections']],
  [/\bconnect|connections\b/, ['list-connections']],
  [/\b(find|query)\b/, ['find']],
];

const fixtures = join(here, '../../../../../packages/harness/test/fixtures');
const CATALOG_NAMES: Record<Box, Set<string>> = {
  github: toolNames('github-catalog.json'),
  fs: toolNames('filesystem-catalog.json'),
  mongo: toolNames('mongodb-catalog.json'),
};
function toolNames(file: string): Set<string> {
  const json = JSON.parse(readFileSync(join(fixtures, file), 'utf8')) as {
    tools: { name: string }[];
  };
  return new Set(json.tools.map((t) => t.name));
}

const RULES: Record<Box, Rule[]> = { fs: FS_RULES, github: GH_RULES, mongo: MONGO_RULES };

/** The intent set of a query on one catalog: the union of every matching rule; undefined = content. */
function intent(box: Box, query: string): string[] | undefined {
  // Underscores read as spaces, so a guessed name like add_comment hits the rules.
  const q = query.toLowerCase().replace(/_/g, ' ');
  const out = new Set<string>();
  // A query word that IS a tool name names that tool.
  for (const word of query.split(/\s+/)) if (CATALOG_NAMES[box].has(word)) out.add(word);
  for (const [pattern, tools] of RULES[box]) if (pattern.test(q)) tools.forEach((t) => out.add(t));
  return out.size > 0 ? [...out] : undefined;
}

/** Recorded global (multi) search_tools queries: few enough to label by hand. */
const MULTI_RECORDED: Record<string, string[] | null> = {
  'CSV export feature release': ['github.list_releases', 'github.get_latest_release'],
  'CSV export issue pull request': [
    'github.list_issues',
    'github.search_issues',
    'github.list_pull_requests',
    'github.search_pull_requests',
  ],
  'CSV export release': ['github.list_releases', 'github.get_latest_release'],
  'CSV export': null,
  'customer order email': null,
  'github pull request check runs status': ['github.pull_request_read'],
  'list pull requests': ['github.list_pull_requests', 'github.search_pull_requests'],
  'mongo database customer email': ['mongo.find'],
  'pull request check runs status': ['github.pull_request_read'],
  'search issues': ['github.search_issues'],
  'user customer order email': null,
  'version release': ['github.get_latest_release', 'github.list_releases'],
  'widgets project': null,
  'widgets version package': null,
};

// Single-word or data-only queries an intent rule would over-read.
const FORCE_CONTENT = new Set(['file', 'database', 'customer', 'customers', 'product']);

// ---------------------------------------------------------------------------
// Recorded queries
// ---------------------------------------------------------------------------

interface Use {
  name: string;
  input?: { name?: unknown; query?: unknown };
  isError?: boolean;
}
interface RecordLike {
  world?: string;
  task?: string;
  toolUses?: Use[];
  model?: string;
  run?: number;
  wallMs?: number;
}

const FACADE_SEARCH = new Set(['search_tools', 'search_github', 'search_fs', 'search_mongo']);
const WORLD_BOX: Record<string, Box> = { github: 'github', filesystem: 'fs', mongodb: 'mongo' };

function surfaceOf(world: string, tool: string): Surface | undefined {
  if (tool === 'search_tools') return world === 'multi' ? 'multi' : WORLD_BOX[world];
  if (world !== 'multi') return undefined;
  return `multi:${tool.slice('search_'.length)}` as Surface;
}

function boxOf(surface: Surface): Box | undefined {
  if (surface === 'multi' || surface === 'synthetic') return undefined;
  return (surface.startsWith('multi:') ? surface.slice(6) : surface) as Box;
}

/** A tool name the model used, as `surface` names it, or undefined when out of scope. */
function inScope(surface: Surface, name: string): string | undefined {
  const box = boxOf(surface);
  if (surface === 'multi') return name.includes('.') ? name : undefined;
  if (box === undefined) return undefined;
  if (surface.startsWith('multi:'))
    return name.startsWith(`${box}.`) ? name.slice(box.length + 1) : undefined;
  return name.includes('.') ? undefined : name;
}

interface Recorded {
  surface: Surface;
  query: string;
  seen: number;
  used: Map<string, number>;
}

function readRecorded(fileList: string): { recorded: Map<string, Recorded>; episodes: number } {
  const files = readFileSync(fileList, 'utf8').trim().split('\n');
  const seenEpisodes = new Set<string>();
  const recorded = new Map<string, Recorded>();
  for (const file of files) {
    let json: { records?: RecordLike[] };
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as { records?: RecordLike[] };
    } catch {
      continue;
    }
    if (!Array.isArray(json.records)) continue;
    for (const record of json.records) {
      const uses = record.toolUses ?? [];
      const key = JSON.stringify([record.task, record.model, record.run, record.wallMs, uses]);
      if (seenEpisodes.has(key)) continue;
      seenEpisodes.add(key);
      uses.forEach((use, i) => {
        if (!FACADE_SEARCH.has(use.name)) return;
        const surface = surfaceOf(record.world ?? '', use.name);
        const query = typeof use.input?.query === 'string' ? use.input.query.trim() : '';
        if (surface === undefined || query === '') return;
        const id = `${surface}\t${query}`;
        const entry = recorded.get(id) ?? { surface, query, seen: 0, used: new Map() };
        entry.seen += 1;
        for (let k = i + 1; k < uses.length; k++) {
          const next = uses[k] as Use;
          if (next.name.startsWith('search_')) break;
          if ((next.name !== 'describe_tool' && next.name !== 'call_tool') || next.isError === true)
            continue;
          const name =
            typeof next.input?.name === 'string' ? inScope(surface, next.input.name) : undefined;
          if (name !== undefined) entry.used.set(name, (entry.used.get(name) ?? 0) + 1);
        }
        recorded.set(id, entry);
      });
    }
  }
  return { recorded, episodes: seenEpisodes.size };
}

// ---------------------------------------------------------------------------
// Hand-written queries (written before any ranking was measured)
// ---------------------------------------------------------------------------

const HANDWRITTEN: Record<'github' | 'fs' | 'mongo' | 'multi', [string, string[]][]> = {
  github: [
    ['open a pull request', ['create_pull_request']],
    ['who am I', ['get_me']],
    ['my user profile', ['get_me']],
    ['delete a file from the repo', ['delete_file']],
    ['push several files in one commit', ['push_files']],
    ['create or update a file', ['create_or_update_file']],
    ['fork a repo', ['fork_repository']],
    ['new repository', ['create_repository']],
    ['list commits on main', ['list_commits']],
    ['commit details', ['get_commit']],
    ['latest release', ['get_latest_release']],
    ['release by tag', ['get_release_by_tag']],
    ['code scanning alerts', ['list_code_scanning_alerts', 'get_code_scanning_alert']],
    ['secret scanning alerts', ['list_secret_scanning_alerts', 'get_secret_scanning_alert']],
    [
      'security advisories',
      [
        'list_global_security_advisories',
        'list_repository_security_advisories',
        'list_org_repository_security_advisories',
        'get_global_security_advisory',
      ],
    ],
    ['workflow job logs', ['get_job_logs']],
    ['list workflows', ['actions_list']],
    ['cancel a workflow run', ['actions_run_trigger']],
    ['ask copilot to review my PR', ['request_copilot_review']],
    ['approve the pull request', ['pull_request_review_write']],
    ['update PR branch with base', ['update_pull_request_branch']],
    ['edit pull request title', ['update_pull_request']],
    ['list labels', ['list_label']],
    ['create a label', ['label_write']],
    ['add a sub-issue', ['sub_issue_write']],
    ['mark notifications as read', ['mark_all_notifications_read', 'dismiss_notification']],
    ['unstar a repo', ['unstar_repository']],
    ['list discussions', ['list_discussions']],
    ['discussion comments', ['get_discussion_comments', 'discussion_comment_write']],
    ['create a gist', ['create_gist']],
    ['team members', ['get_team_members']],
    ['repo collaborators', ['list_repository_collaborators']],
    ['search code for a function', ['search_code']],
    ['find users by name', ['search_users']],
    ['project board items', ['projects_list', 'projects_get', 'projects_write']],
    ['issue types', ['list_issue_types']],
    ['branch protection rules', ['repository_ruleset_read', 'create_repository_ruleset']],
    ['check dependencies for vulnerabilities', ['check_dependency_vulnerabilities']],
    ['edit a comment', ['update_issue_comment']],
    ['reopen an issue', ['issue_write']],
    ['assign issue to someone', ['issue_write']],
    ['get README', ['get_file_contents']],
    ['PR diff', ['pull_request_read']],
    ['find similar issues', ['semantic_issue_similarity_search', 'search_issues']],
    ['createIssue', ['issue_write']],
    ['listPullRequests', ['list_pull_requests']],
    ['get-file-contents', ['get_file_contents']],
  ],
  fs: [
    ['cat a file', ['read_text_file', 'read_file']],
    ['show first 10 lines of a file', ['read_text_file']],
    ['overwrite file contents', ['write_file']],
    ['make a new folder', ['create_directory']],
    ['rename a file', ['move_file']],
    ['where am I allowed to write', ['list_allowed_directories']],
    ['file modification time', ['get_file_info']],
    ['find files by name pattern', ['search_files']],
    ['biggest files in folder', ['list_directory_with_sizes']],
    ['recursive listing', ['directory_tree']],
    ['replace a line in a file', ['edit_file']],
    ['read several files at once', ['read_multiple_files']],
    ['view a png', ['read_media_file']],
    ['ls', ['list_directory', 'list_directory_with_sizes']],
    ['mkdir -p', ['create_directory']],
    ['does this file exist', ['get_file_info', 'search_files']],
    ['patch a file with a diff', ['edit_file']],
    ['save text to disk', ['write_file']],
    ['readTextFile', ['read_text_file']],
    ['list-directory', ['list_directory']],
  ],
  mongo: [
    ['query documents with a filter', ['find']],
    ['how many documents', ['count']],
    ['group by and sum', ['aggregate']],
    ['add documents', ['insert-many']],
    ['upsert a document', ['update-many']],
    ['remove documents matching', ['delete-many']],
    ['drop a database', ['drop-database']],
    ['show databases', ['list-databases']],
    ['show collections', ['list-collections']],
    ['collection size on disk', ['collection-storage-size']],
    ['database stats', ['db-stats']],
    ['what fields does a collection have', ['collection-schema']],
    ['which indexes exist', ['collection-indexes']],
    ['add an index on email', ['create-index']],
    ['remove an index', ['drop-index']],
    ['query plan', ['explain']],
    ['rename collection', ['rename-collection']],
    ['new collection', ['create-collection']],
    ['sort and limit results', ['find', 'aggregate']],
    ['insert_many', ['insert-many']],
    ['listCollections', ['list-collections']],
  ],
  multi: [
    ['read a local file', ['fs.read_text_file', 'fs.read_file']],
    ['read a file from the repository', ['github.get_file_contents']],
    ['search code in the repo', ['github.search_code']],
    ['find files on disk', ['fs.search_files']],
    ['list my repos', ['github.search_repositories', 'github.get_me']],
    ['count orders in the database', ['mongo.count']],
    ['find customers', ['mongo.find']],
    ['insert a record', ['mongo.insert-many']],
    ['write a file to disk', ['fs.write_file']],
    ['commit a file to GitHub', ['github.create_or_update_file', 'github.push_files']],
    ['list directory', ['fs.list_directory', 'fs.list_directory_with_sizes']],
    ['repository tree', ['github.get_repository_tree']],
    ['delete documents', ['mongo.delete-many']],
    ['open an issue', ['github.issue_write']],
    ['comment on an issue', ['github.add_issue_comment']],
    ['merge PR', ['github.merge_pull_request']],
    ['list collections', ['mongo.list-collections']],
    ['aggregation pipeline', ['mongo.aggregate', 'mongo.aggregate-db']],
    ['create a folder', ['fs.create_directory']],
    ['move a file', ['fs.move_file']],
    ['edit a local file', ['fs.edit_file']],
    ['update documents', ['mongo.update-many']],
    ['create branch', ['github.create_branch']],
    ['list releases', ['github.list_releases']],
    ['collection schema', ['mongo.collection-schema']],
    ['file metadata', ['fs.get_file_info']],
    ['open pull requests', ['github.list_pull_requests', 'github.search_pull_requests']],
    ['drop collection', ['mongo.drop-collection']],
    ['explain query', ['mongo.explain']],
    ['mongo find', ['mongo.find']],
    ['github issues', ['github.list_issues', 'github.search_issues']],
    ['fs read', ['fs.read_text_file', 'fs.read_file']],
  ],
};

// ---------------------------------------------------------------------------
// Assemble, split, write
// ---------------------------------------------------------------------------

function tokenKey(query: string): string {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0),
    ),
  ]
    .toSorted()
    .join(' ');
}

const fileList = process.argv[2];
if (fileList === undefined)
  throw new Error('usage: build-corpus.ts <file listing transcript paths>');
const { recorded, episodes } = readRecorded(fileList);

const cases: Case[] = [];
const content: { surface: Surface; query: string; seen: number }[] = [];
let n = 0;
const nextId = (prefix: string): string => `${prefix}-${String(++n).padStart(4, '0')}`;

for (const entry of [...recorded.values()].toSorted((a, b) =>
  `${a.surface}\t${a.query}` < `${b.surface}\t${b.query}` ? -1 : 1,
)) {
  const box = boxOf(entry.surface);
  let want: string[] | undefined;
  if (entry.surface === 'multi') {
    const label = MULTI_RECORDED[entry.query];
    if (label === undefined)
      throw new Error(`unlabeled multi query ${JSON.stringify(entry.query)}`);
    want = label ?? undefined;
  } else if (box !== undefined && !FORCE_CONTENT.has(entry.query.toLowerCase())) {
    want = intent(box, entry.query);
  }
  if (want === undefined) {
    content.push({ surface: entry.surface, query: entry.query, seen: entry.seen });
    continue;
  }
  const used = want.filter((tool) => entry.used.has(tool));
  const gold = used.length > 0 ? used : want;
  cases.push({
    id: nextId('rec'),
    surface: entry.surface,
    query: entry.query,
    gold,
    source: 'recorded',
    seen: entry.seen,
    label: used.length > 0 ? 'used' : 'intent',
  });
  // The same query against the 130-tool global search (projection mode's search_tools).
  if (box !== undefined) {
    cases.push({
      id: nextId('lift'),
      surface: 'multi',
      query: entry.query,
      gold: gold.map((tool) => `${box}.${tool}`),
      source: 'recorded-lifted',
    });
  }
}

// Recorded queries repeat across surfaces (search_tools on the github world
// and search_github on the multi world): keep one lifted copy per query.
const liftedSeen = new Set<string>();
for (let i = cases.length - 1; i >= 0; i--) {
  const c = cases[i] as Case;
  if (c.source !== 'recorded-lifted') continue;
  const key = `${c.query}\t${c.gold.join(',')}`;
  if (liftedSeen.has(key)) cases.splice(i, 1);
  else liftedSeen.add(key);
}

for (const [surface, list] of Object.entries(HANDWRITTEN) as [Surface, [string, string[]][]][]) {
  for (const [query, gold] of list) {
    cases.push({ id: nextId('hand'), surface, query, gold, source: 'handwritten' });
  }
}
for (const q of syntheticQueries(150, SEED)) {
  cases.push({
    id: nextId('syn'),
    surface: 'synthetic',
    query: q.query,
    gold: [q.gold],
    source: 'generated',
    paraphrase: q.paraphrase,
  });
}

// Split by token-set group under a fixed seed.
const random = seededRandom(SEED);
const groupSplit = new Map<string, 'train' | 'test'>();
for (const key of [...new Set(cases.map((c) => tokenKey(c.query)))].toSorted()) {
  groupSplit.set(key, random() < TRAIN_FRACTION ? 'train' : 'test');
}
for (const c of cases) c.split = groupSplit.get(tokenKey(c.query)) ?? 'train';

const corpus = {
  description:
    'Offline search-retrieval corpus (see packages/harness/src/eval/offline/search-eval.ts). Built by .claude/hillclimb/multi-server/explore/offline-search/build-corpus.ts; do not hand-edit.',
  seed: SEED,
  trainFraction: TRAIN_FRACTION,
  recordedEpisodes: episodes,
  cases,
  content,
};
writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`);
const count = (pred: (c: Case) => boolean): number => cases.filter(pred).length;
console.log(
  `${cases.length} cases (train ${count((c) => c.split === 'train')}, test ${count((c) => c.split === 'test')}); ` +
    `recorded ${count((c) => c.source === 'recorded')} (used-labelled ${count((c) => c.label === 'used')}), ` +
    `lifted ${count((c) => c.source === 'recorded-lifted')}, hand ${count((c) => c.source === 'handwritten')}, ` +
    `generated ${count((c) => c.source === 'generated')}; content queries ${content.length} ` +
    `(${content.reduce((s, c) => s + c.seen, 0)} issued); from ${episodes} episodes`,
);
