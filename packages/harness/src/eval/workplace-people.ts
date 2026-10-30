/**
 * The people of the workplace world (workplace-world.ts) and the one
 * instant the world treats as "now". Every box knows a person by a
 * different handle, as real tools do:
 *
 * - `chat` by an opaque user ID (`U07K2M9QF3A`), mentioned in message text
 *   as `<@U07K2M9QF3A>`; the email is only on the user's profile;
 * - `tracker` by email (assignees, `list_users`);
 * - `errors` by the commit author's email on a suspect commit;
 * - `docs` by display name, inside a user mention's `plain_text`
 *   (`@Aiko Tanaka`) next to a docs-only user UUID;
 * - `mail` by email address.
 *
 * Nothing here reads the clock: {@link WORLD_NOW} is fixed, and relative
 * windows (`24h`, `7d`) in the errors box are measured from it.
 */

/** The world's "now": Wednesday 2026-10-14, 12:00 UTC. */
export const WORLD_NOW = '2026-10-14T12:00:00Z';
/** The date the host framing states. */
export const WORLD_TODAY = '2026-10-14';

export const ORG_DOMAIN = 'northwind.dev';

export interface Person {
  /** Full name, as `chat` real_name and the docs display name. */
  name: string;
  email: string;
  /** chat user ID. */
  chatId: string;
  /** chat handle (`name` in the users list). */
  handle: string;
  /** docs user UUID. */
  docsId: string;
  /** tracker user ID. */
  trackerId: string;
  title: string;
  /** Deactivated in chat (left the company); still known to the tracker. */
  chatDeleted?: boolean;
}

function person(
  name: string,
  handle: string,
  chatId: string,
  docsId: string,
  trackerId: string,
  title: string,
  extra: Partial<Person> = {},
): Person {
  const email = `${name.toLowerCase().replace(/ /g, '.')}@${ORG_DOMAIN}`;
  return { name, email, chatId, handle, docsId, trackerId, title, ...extra };
}

export const PEOPLE = {
  priya: person(
    'Priya Raman',
    'priya.r',
    'U07K2M9QF3A',
    '3b1f6c2e-9a4d-4e57-8c11-2f0a9d7e5b31',
    'usr_8c2d1f04',
    'Senior Backend Engineer',
  ),
  marco: person(
    'Marco Silva',
    'marco',
    'U07L4R2XB8C',
    '5c9e0a7b-1d2f-4a63-9e88-6b4c3d2a1f09',
    'usr_1a7e9b33',
    'Staff Engineer, Payments',
  ),
  marcoB: person(
    'Marco Bianchi',
    'mbianchi',
    'U02M7Z4WQ1J',
    '7e2a4b9c-3f1d-4c08-a5e6-9d8b7c6a5f42',
    'usr_4f0c2e91',
    'Product Designer',
  ),
  dana: person(
    'Dana Okafor',
    'dana',
    'U05QW1Z7H2D',
    '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
    'usr_6b3d8a20',
    'Engineering Manager, Backend',
  ),
  jonas: person(
    'Jonas Weber',
    'jonas.w',
    'U06B8N3TP4E',
    '2d4f6a8c-0e1b-4d3f-9a5c-7e9b1d3f5a7c',
    'usr_9e5a7c12',
    'Backend Engineer, Billing',
  ),
  aiko: person(
    'Aiko Tanaka',
    'aiko',
    'U07T1C5VK9F',
    '6f8a0c2e-4b6d-4f1a-8c3e-5a7c9e1b3d5f',
    'usr_2c8f4d67',
    'Site Reliability Engineer',
  ),
  sam: person(
    'Sam Rivera',
    'sam',
    'U04HX7D2M1G',
    '8b0d2f4a-6c8e-4a1c-9e3a-5c7e9a1c3e5a',
    'usr_7d1b5e38',
    'Backend Engineer, Notifications',
  ),
  lena: person(
    'Lena Fischer',
    'lena.f',
    'U03D9K2LQ5H',
    '4c6e8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c',
    'usr_3a6c9f85',
    'Backend Engineer',
    { chatDeleted: true },
  ),
  omar: person(
    'Omar Haddad',
    'omar.h',
    'U06Y3R8PL2K',
    '1e3a5c7e-9a1c-4e5a-8c9e-1a3c5e7a9c1e',
    'usr_5f2a8d46',
    'Backend Engineer',
  ),
  grace: person(
    'Grace Liu',
    'grace',
    'U01QA2B3C4D',
    '0a2c4e6a-8c0e-4a2c-9e6a-8c0e2a4c6e8a',
    'usr_0b4e7a19',
    'QA Lead',
  ),
} as const satisfies Record<string, Person>;

export type PersonKey = keyof typeof PEOPLE;

export const ALL_PEOPLE: readonly Person[] = Object.values(PEOPLE);

/** Chat bots (no email, no tracker account). */
export const BOTS = {
  deploy: { chatId: 'U00DPLY0B07', handle: 'deploybot', name: 'Deploy Bot' },
  errors: { chatId: 'U00ERRB0T42', handle: 'errors-bot', name: 'Errors Bot' },
} as const;
