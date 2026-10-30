#!/usr/bin/env python3
"""Per-episode table for a harness results file: pass, execute_machine attempts
and outcomes, round trips (approvals), turns, cost.

usage: analyze.py <results.json> [--detail]
"""
import json, re, sys

PRICES = {
    'claude-haiku-4-5': (1, 5),
    'claude-sonnet-5-5': (2, 10),
}


def usd(model_id, u):
    p = PRICES.get(model_id)
    if not p:
        return 0.0
    inp = u['inputTokens'] + u['cacheReadInputTokens'] * 0.1 + u['cacheCreationInputTokens'] * 1.25
    return (inp * p[0] + u['outputTokens'] * p[1]) / 1e6


def classify(text, is_error):
    if text is None:
        return '?'
    t = text if isinstance(text, str) else json.dumps(text)
    m = re.search(r'"phase"\s*:\s*"(\w+)"', t)
    if m:
        phase = m.group(1)
        if phase == 'cap_exceeded':
            lim = re.search(r'(round[_ ]?trips?|maxRoundTrips|max\w+)', t, re.I)
            return 'cap:' + (lim.group(1) if lim else '?')
        return phase
    if is_error:
        low = t.lower()
        for ph in ('transpile', 'validate', 'runtime', 'cap_exceeded', 'terminal', 'protocol'):
            if ph in low[:400]:
                return ph + '*'
        return 'error'
    return 'ok'


def episode_rows(d):
    rows = []
    for r in d['records']:
        tr = r.get('transcript') or {'messages': []}
        uses = {}
        results = {}
        for m in tr['messages']:
            if isinstance(m['content'], str):
                continue
            for b in m['content']:
                if b.get('type') == 'tool_use':
                    uses[b['id']] = b
                elif b.get('type') == 'tool_result':
                    results[b['tool_use_id']] = b
        em = []
        for uid, b in uses.items():
            if b['name'] != 'execute_machine':
                continue
            res = results.get(uid, {})
            c = res.get('content')
            em.append((classify(c, res.get('is_error')), c))
        names = [u['name'] for u in r.get('toolUses', [])]
        call_tool = sum(1 for n in names if n == 'call_tool')
        rows.append({
            'task': r['task'], 'model': r['model'], 'success': r['success'],
            'forbidden': r.get('forbidden'), 'turns': r['apiTurns'],
            'turnCapped': r.get('turnCapped'),
            'approvals': (r.get('projection') or {}).get('approvals'), 'rt': (r.get('projection') or {}).get('roundTrips'),
            'route': (r.get('projection') or {}).get('route'),
            'em': [e[0] for e in em], 'em_raw': [e[1] for e in em],
            'call_tool': call_tool, 'usd': usd(r['modelId'], r['usage']),
            'harnessError': r.get('harnessError'),
            'final': r.get('finalText', ''),
        })
    return rows


def main():
    d = json.load(open(sys.argv[1]))
    detail = '--detail' in sys.argv
    rows = episode_rows(d)
    print(f"systemSuffix={d.get('systemSuffix')!r} episodes={len(rows)}")
    print('| task | model | pass | route | execute_machine outcomes | call_tool | approvals | round trips | turns | $ |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    tot = 0
    for x in sorted(rows, key=lambda x: (x['task'], x['model'])):
        tot += x['usd']
        p = 'PASS' if x['success'] else ('FORBID' if x['forbidden'] else 'fail')
        if x['harnessError']:
            p = 'HARNESS'
        tc = ' (capped)' if x['turnCapped'] else ''
        print(f"| {x['task']} | {x['model']} | {p} | {x['route']} | {', '.join(x['em']) or '-'} | {x['call_tool']} | {x['approvals']} | {x['rt']} | {x['turns']}{tc} | {x['usd']:.4f} |")
    print(f'total ${tot:.4f}')
    for m in sorted({x['model'] for x in rows}):
        rs = [x for x in rows if x['model'] == m]
        s = sum(1 for x in rs if x['success'])
        c = sum(x['usd'] for x in rs)
        print(f"{m}: {s}/{len(rs)} pass, ${c:.4f}, $/success {c/s if s else float('inf'):.4f}")
    if detail:
        for x in rows:
            for i, (o, raw) in enumerate(zip(x['em'], x['em_raw'])):
                if o != 'ok':
                    t = raw if isinstance(raw, str) else json.dumps(raw)
                    print(f"\n### {x['task']} {x['model']} attempt {i+1}: {o}\n{t[:600]}")


main()
