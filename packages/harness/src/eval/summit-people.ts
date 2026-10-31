/**
 * The people of the summit world's company, Fernhill (fernhill.io), and
 * how each of them appears in every product: a Slack user ID and handle, a
 * Notion user UUID, a Sentry user ID, an email. The products never share an
 * identifier, so joining across them goes through the email or the display
 * name, as it does for real.
 *
 * Near-duplicates on purpose: two Sams (Okafor, a CSM; Okoro, in support),
 * two Priyas (Raman, an engineer; Ramanathan, in sales), an accented name
 * (Tomás Ruiz), a deactivated Slack account (Tom Becker), and three Staff
 * Engineers in Berlin next to one in Los Angeles and one deactivated.
 *
 * The assistant acts for Raj Mehta (Engineering Manager, Payments): his is
 * the Sentry token (`whoami`), and the Slack and Notion integrations are a
 * bot called "Fernhill Assistant".
 */

import { prng, uuidFrom } from './summit-core.js';

export interface Person {
  key: string;
  name: string;
  email: string;
  title: string;
  tz: string;
  slackId: string;
  /** The Slack `name` (handle). */
  slackName: string;
  notionId: string;
  sentryId: string;
  /** Slack account deactivated. */
  deleted?: boolean;
}

const TZ_LABEL: Record<string, [string, number]> = {
  'America/New_York': ['Eastern Daylight Time', -14400],
  'America/Chicago': ['Central Daylight Time', -18000],
  'America/Los_Angeles': ['Pacific Daylight Time', -25200],
  'Europe/London': ['Greenwich Mean Time', 0],
  'Europe/Berlin': ['Central European Time', 3600],
  'Europe/Lisbon': ['Western European Time', 0],
  'Asia/Tokyo': ['Japan Standard Time', 32400],
  'Asia/Kolkata': ['India Standard Time', 19800],
  'Australia/Sydney': ['Australian Eastern Daylight Time', 39600],
};

export function tzLabel(tz: string): [string, number] {
  return TZ_LABEL[tz] ?? ['Coordinated Universal Time', 0];
}

function person(
  key: string,
  name: string,
  title: string,
  tz: string,
  slackId: string,
  sentryId: string,
  extra: Partial<Person> = {},
): Person {
  const [first, ...rest] = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(' ');
  const local = `${first}.${rest.join('')}`;
  return {
    key,
    name,
    email: `${local}@fernhill.io`,
    title,
    tz,
    slackId,
    slackName: local.replace('.', ''),
    notionId: uuidFrom(`notion-user:${key}`),
    sentryId,
    ...extra,
  };
}

/** The named people, by key. Slack IDs are chosen so `users.list` order puts some on page 2. */
export const PEOPLE = {
  raj: person(
    'raj',
    'Raj Mehta',
    'Engineering Manager, Payments',
    'Europe/London',
    'U02RJM4K7PL',
    '2041187',
  ),
  dana: person(
    'dana',
    'Dana Whitfield',
    'Head of Finance',
    'America/New_York',
    'U02DW8HF31Q',
    '2041190',
  ),
  priya: person(
    'priya',
    'Priya Raman',
    'Senior Backend Engineer',
    'Europe/London',
    'U03PR9B2MXK',
    '2041203',
  ),
  priyaR: person(
    'priyaR',
    'Priya Ramanathan',
    'Account Executive',
    'America/Chicago',
    'U05PRM2T8QA',
    '2041322',
  ),
  marcus: person(
    'marcus',
    'Marcus Bell',
    'Staff Engineer',
    'Europe/Berlin',
    'U03MB7C1Q2T',
    '2041207',
  ),
  jonas: person(
    'jonas',
    'Jonas Weber',
    'Staff Engineer',
    'Europe/Berlin',
    'U04JW2D9KLE',
    '2041244',
  ),
  lena: person('lena', 'Lena Fischer', 'Staff Engineer', 'Europe/Berlin', 'UA7LF4P0WZR', '2041291'),
  erik: person(
    'erik',
    'Erik Sandoval',
    'Staff Engineer',
    'America/Los_Angeles',
    'U04ES6N3VBA',
    '2041250',
  ),
  karl: person(
    'karl',
    'Karl Brenner',
    'Staff Engineer',
    'Europe/Berlin',
    'U03KB0T5RRS',
    '2041219',
    {
      deleted: true,
    },
  ),
  sam: person(
    'sam',
    'Sam Okafor',
    'Customer Success Manager',
    'America/New_York',
    'U04SO3M8ZPD',
    '2041261',
  ),
  samO: person('samO', 'Sam Okoro', 'Support Engineer', 'Europe/Lisbon', 'U05SK1R7HJW', '2041330'),
  aisha: person(
    'aisha',
    'Aisha Karim',
    'Customer Success Manager',
    'Europe/London',
    'U04AK7W2CQF',
    '2041266',
  ),
  tomas: person(
    'tomas',
    'Tomás Ruiz',
    'Customer Success Manager',
    'America/Chicago',
    'UA2TR8V6MNB',
    '2041299',
  ),
  tom: person(
    'tom',
    'Tom Becker',
    'Customer Success Manager',
    'America/New_York',
    'U03TB4X9KDS',
    '2041222',
    {
      deleted: true,
    },
  ),
  hannah: person(
    'hannah',
    'Hannah Cole',
    'Frontend Engineer',
    'America/New_York',
    'U04HC5Y1NTE',
    '2041270',
  ),
  kenji: person('kenji', 'Kenji Watanabe', 'iOS Engineer', 'Asia/Tokyo', 'U05KW9A4GHU', '2041311'),
  olivia: person(
    'olivia',
    'Olivia Brandt',
    'Support Lead',
    'Europe/Berlin',
    'U03OB6E2LVM',
    '2041226',
  ),
  nadia: person(
    'nadia',
    'Nadia Petrova',
    'Site Reliability Engineer',
    'Europe/Berlin',
    'U04NP8G3SXY',
    '2041274',
  ),
} as const satisfies Record<string, Person>;

export type PersonKey = keyof typeof PEOPLE;
export const NAMED_PEOPLE: readonly Person[] = Object.values(PEOPLE);

/** The integration bots. */
export const ASSISTANT = {
  name: 'Fernhill Assistant',
  slackUserId: 'U0BFHASST01',
  slackBotId: 'B0BFHASST01',
  notionBotId: uuidFrom('notion-bot:assistant'),
} as const;

const FIRST = [
  'Ada',
  'Ben',
  'Carla',
  'Diego',
  'Elif',
  'Femi',
  'Greta',
  'Hugo',
  'Ines',
  'Jamal',
  'Kira',
  'Liam',
  'Mina',
  'Noah',
  'Oona',
  'Pavel',
  'Quinn',
  'Rosa',
  'Sven',
  'Tara',
  'Umar',
  'Vera',
  'Wes',
  'Xenia',
  'Yusuf',
  'Zoe',
  'Arjun',
  'Bea',
  'Chen',
  'Dmitri',
  'Esme',
  'Farah',
  'Gil',
  'Hana',
  'Ivo',
  'Juno',
];
const LAST = [
  'Adler',
  'Bianchi',
  'Costa',
  'Dubois',
  'Eriksen',
  'Fontaine',
  'Garcia',
  'Haas',
  'Iqbal',
  'Jensen',
  'Kowalski',
  'Lambert',
  'Moreau',
  'Nakamura',
  'Ortiz',
  'Park',
  'Quist',
  'Rossi',
  'Schmidt',
  'Tanaka',
  'Ueda',
  'Varga',
  'Walsh',
  'Yilmaz',
  'Zimmer',
  'Novak',
  'Silva',
  'Horvat',
  'Larsen',
  'Meyer',
];
const TITLES = [
  'Software Engineer',
  'Senior Software Engineer',
  'Product Designer',
  'Product Manager',
  'Account Executive',
  'Sales Development Rep',
  'Support Engineer',
  'Data Analyst',
  'Engineering Manager',
  'Recruiter',
  'Marketing Manager',
  'QA Engineer',
  'Solutions Engineer',
  'Senior Product Designer',
  'Technical Writer',
  'Office Manager',
  'Finance Analyst',
  'Principal Engineer',
  'Staff Product Designer',
  'Senior Staff Engineer',
];
const TZS = Object.keys(TZ_LABEL);

/** Everyone else in the Slack workspace: 118 generated colleagues (no Notion or Sentry identity). */
export function otherSlackPeople(): Person[] {
  const rand = prng(7041);
  const out: Person[] = [];
  const seen = new Set(NAMED_PEOPLE.map((p) => p.name));
  for (let i = 0; out.length < 118; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(rand() * LAST.length)]}`;
    if (seen.has(name)) continue;
    seen.add(name);
    let title = TITLES[Math.floor(rand() * TITLES.length)] as string;
    const tz = TZS[Math.floor(rand() * TZS.length)] as string;
    // "Senior Staff Engineer" in Berlin would make the Staff-Engineer question ambiguous.
    if (title === 'Senior Staff Engineer' && tz === 'Europe/Berlin')
      title = 'Senior Software Engineer';
    const n = (i * 7919 + 13) % 1_000_000;
    const slackId = `U0${(n % 9) + 1}${n.toString(36).toUpperCase().padStart(4, 'X')}${'QWRTPLKJ'[i % 8]}${'ZXCVBNMA'[(i * 3) % 8]}${(i % 10).toString()}`;
    out.push(
      person(
        `gen${i}`,
        name,
        title,
        tz,
        slackId,
        String(2042000 + i),
        i % 23 === 7 ? { deleted: true } : {},
      ),
    );
  }
  return out;
}
