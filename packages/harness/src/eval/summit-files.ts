/**
 * The summit world's `fs` box tree: Raj's local files, served by the real
 * filesystem reference server (filesystem-world.ts) in place of the widgets
 * fixture — a checkout of Fernhill's `api` repository (CODEOWNERS with
 * overlapping rules, a CHANGELOG that names Sentry issues by short ID and by
 * URL, the source files the Sentry culprits point at) and a finance export.
 */

import { stripeCustomerIds } from './summit-stripe.js';

export const CODEOWNERS = `# Code owners for fernhill/api. The LAST matching pattern takes precedence.

*                                   @fernhill/backend
/fernhill/api/                      @fernhill/backend
/fernhill/billing/                  @fernhill/payments
/fernhill/billing/tax/              @fernhill/payments @fernhill/tax-squad
/fernhill/billing/invoices.py       @priya-raman @fernhill/payments
/fernhill/billing/proration.py      @fernhill/payments @raj-mehta
/fernhill/calendar/                 @fernhill/integrations
/fernhill/db/                       @fernhill/platform
/docs/                              @fernhill/docs
`;

export const CHANGELOG = `# Changelog

All notable changes to fernhill/api. Sentry references are short IDs or issue links.

## 2026.10.5 (unreleased)

- Calendar: tolerate VEVENTs without a timezone (in review)

## 2026.10.4 (2026-10-27)

- Billing: fix proration rounding for mid-cycle seat changes (API-52C)
- Billing worker: stop reusing idempotency keys across card retries (BILLING-WORKER-2H)
- Invites: handle Outlook invites with no organizer (https://fernhill.sentry.io/issues/6019922310/)
- Webhooks: retry delivery on 502 from the hooks gateway (API-4V8)
- Raise the tax client connection pool from 10 to 20

## 2026.10.3 (2026-10-20)

- Calendar: back off on Google quota errors (API-4QX)
- Bookings: lock the slot row before reserving (API-5Z1, partial fix)

## 2026.10.2 (2026-10-13)

- Invoices: credits v2
`;

const INVOICES_PY = `"""Invoice credits and adjustments."""

from decimal import Decimal

from fernhill.billing.models import Credit, Invoice


def apply_credit(invoice: Invoice, credit: Credit) -> Invoice:
    """Apply a customer credit to an open invoice."""
    if invoice.status != "open":
        raise ValueError("can only credit open invoices")
    try:
        if credit.amount > invoice.balance:
            raise ValueError(f"credit amount {credit.amount} exceeds invoice balance {invoice.balance}")
    except Exception:
        raise
    invoice.balance -= credit.amount
    return invoice
`;

const TAX_CLIENT_PY = `"""TaxJar client."""

import requests


class TaxClient:
    def __init__(self, token: str):
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {token}"

    def calculate(self, lines, address):
        payload = {"lines": [l.as_dict() for l in lines], "to": address.as_dict()}
        try:
            resp = self.session.post("https://api.taxjar.com/v2/taxes", json=payload, timeout=5)
        except Exception:
            raise
        return resp.json()["tax"]
`;

export function refundRequestsCsv(): string {
  const c = stripeCustomerIds();
  return [
    'request_id,requested_on,customer_id,customer_name,amount_usd,reason,status,approved_by',
    `RR-1049,2026-10-23,${c['yarrow']},Yarrow Foods,60.90,Duplicate seat charge,approved,Dana Whitfield`,
    `RR-1050,2026-10-23,${c['mosaic']},Mosaic Events,203.00,Disputed unpaid subscription,rejected,`,
    `RR-1051,2026-10-24,${c['brightpath']},Brightpath Logistics,45.50,Unused seats,approved,Dana Whitfield`,
    `RR-1052,2026-10-24,${c['tidal']},Tidal Energy,"1,500.00",Duplicate onboarding charge,approved,Dana Whitfield`,
    `RR-1053,2026-10-25,${c['sable']},Sable Security,120.00,Outage credit,approved,Dana Whitfield`,
    `RR-1054,2026-10-25,${c['riverbend']},Riverbend Schools,"1,250.00",Overbilled summer term,approved,Dana Whitfield`,
    `RR-1055,2026-10-26,${c['kestrel']},Kestrel Analytics,522.00,Churn refund,rejected,`,
    `RR-1056,2026-10-26,${c['velvet']},Velvet Hotels,80.00,Booking credit,approved,Dana Whitfield`,
    `RR-1057,2026-10-27,${c['willow']},Willow Care,99.00,Charged after cancellation,pending,`,
    `RR-1058,2026-10-27,${c['aurora']},Aurora Dance Co,36.00,Workshop seat refund,APPROVED,Dana Whitfield`,
    '',
  ].join('\n');
}

export function summitFiles(): Record<string, string> {
  return {
    'api/README.md':
      '# fernhill/api\n\nDjango API for Fernhill. See CHANGELOG.md for releases and .github/CODEOWNERS for ownership.\n',
    'api/.github/CODEOWNERS': CODEOWNERS,
    'api/CHANGELOG.md': CHANGELOG,
    'api/fernhill/__init__.py': '',
    'api/fernhill/billing/__init__.py': '',
    'api/fernhill/billing/invoices.py': INVOICES_PY,
    'api/fernhill/billing/proration.py':
      '"""Seat proration."""\n\n\ndef prorate_seats(old, new, days_left, days_in_period):\n    expected = round((new - old) * days_left / days_in_period)\n    total = sum(1 for _ in range(expected))\n    assert total == expected, f"prorated amount mismatch (expected {expected}, got {total})"\n    return total\n',
    'api/fernhill/billing/tax/__init__.py': '',
    'api/fernhill/billing/tax/client.py': TAX_CLIENT_PY,
    'api/fernhill/db/session.py':
      '"""Database sessions."""\n\nfrom sqlalchemy import create_engine\n\nengine = create_engine("postgresql://", pool_size=20, max_overflow=10)\n\n\ndef get_session():\n    conn = engine.connect()\n    return conn\n',
    'api/fernhill/calendar/ics.py':
      '"""ICS parsing."""\n\n\ndef parse_vevent(vevent):\n    tz = vevent["timezone"]\n    return tz\n',
    'exports/refund-requests-2026-10.csv': refundRequestsCsv(),
    'exports/stripe-payouts-2026-09.csv':
      'payout_id,arrival_date,amount_usd,status\npo_1Q0aB2,2026-09-02,48210.55,paid\npo_1Q3cD4,2026-09-09,51877.10,paid\npo_1Q6eF6,2026-09-16,49002.31,paid\npo_1Q9gH8,2026-09-23,50318.74,paid\npo_1QCiJ0,2026-09-30,46225.02,paid\n',
    'notes/standup-2026-10-27.md':
      '# Standup 2026-10-27\n\n- Priya: tax client timeouts after the 2026.10.4 deploy\n- Hannah: team calendar crash repro\n- Raj: refund backlog in #billing-requests\n',
  };
}
