"""Compare explore variants against v4 (projection mode) on the multi tier.

usage: python3 compare.py V4_JSON NAME=VARIANT_JSON [NAME=VARIANT_JSON ...]
Prints a markdown table + per-task diffs + Haiku uncached-token check.
"""
import collections
import json
import sys

PRICES = {'haiku45': (1, 5), 'sonnet-low': (2, 10)}


def usd(r):
    u = r['usage']
    i, o = PRICES[r['model']]
    inp = u['inputTokens'] + u['cacheReadInputTokens'] * 0.1 + u['cacheCreationInputTokens'] * 1.25
    return (inp * i + u['outputTokens'] * o) / 1e6


def load(path, mode='projection'):
    d = json.load(open(path))
    return [r for r in d['records'] if r['mode'] == mode and r['tier'] == 'multi']


def cell(records):
    n = len(records)
    succ = sum(1 for r in records if r['success'])
    cost = sum(usd(r) for r in records)
    reps = len({r['run'] for r in records})
    return {
        'n': n,
        'reps': reps,
        'pass_per_rep': succ / reps,
        'succ': succ,
        'usd_ep': cost / n,
        'usd_succ': cost / succ if succ else float('nan'),
        'turns': sum(r['apiTurns'] for r in records) / n,
        'calls': sum(r['toolUseCount'] for r in records) / n,
        'uncached': sum(r['usage']['inputTokens'] for r in records) / n,
        'cread': sum(r['usage']['cacheReadInputTokens'] for r in records) / n,
        'cwrite': sum(r['usage']['cacheCreationInputTokens'] for r in records) / n,
        'out': sum(r['usage']['outputTokens'] for r in records) / n,
        'describe': sum(r['projection']['describeTool'] for r in records) / n,
        'search': sum(r['projection']['searchTools'] + sum(r['projection']['searchBoxes'].values()) for r in records) / n,
        'discover': sum(r['projection']['discoverApis'] for r in records) / n,
        'total': cost,
    }


def main():
    v4 = load(sys.argv[1])
    variants = [a.split('=', 1) for a in sys.argv[2:]]
    rows = [('v4 (3 reps)', v4), ('v4 rep 0', [r for r in v4 if r['run'] == 0])]
    rows += [(name, load(path)) for name, path in variants]
    hdr = '| variant | model | passes (/17) | $/ep | $/success | turns | tool calls | describes/ep | searches/ep | uncached in/ep | cache write/ep | cache read/ep | out/ep |'
    print(hdr)
    print('|' + '---|' * hdr.count('|')[:-1] if False else '|' + '|'.join(['---'] * (hdr.count('|') - 1)) + '|')
    for name, recs in rows:
        for model in PRICES:
            c = cell([r for r in recs if r['model'] == model])
            print(f"| {name} | {model} | {c['pass_per_rep']:.2f} | {c['usd_ep']:.4f} | {c['usd_succ']:.4f} | {c['turns']:.2f} | {c['calls']:.2f} | {c['describe']:.2f} | {c['search']:.2f} | {c['uncached']:,.0f} | {c['cwrite']:,.0f} | {c['cread']:,.0f} | {c['out']:,.0f} |")
    print()
    # per-task pass diffs vs v4 (v4 task passes = k/3)
    v4t = collections.defaultdict(list)
    for r in v4:
        v4t[(r['model'], r['task'])].append(r['success'])
    for name, path in variants:
        recs = load(path)
        print(f'## {name}: task diffs vs v4')
        for r in sorted(recs, key=lambda r: (r['model'], r['task'])):
            base = v4t[(r['model'], r['task'])]
            k = sum(base)
            if r['success'] and k < len(base):
                print(f"  gained  {r['model']:10} {r['task']:30} variant pass, v4 {k}/{len(base)}")
            if not r['success'] and k > 0:
                print(f"  LOST    {r['model']:10} {r['task']:30} variant fail, v4 {k}/{len(base)}  turns={r['apiTurns']} capped={r['turnCapped']}")
        print()
        # haiku uncached first-turn check
        h = [r for r in recs if r['model'] == 'haiku45']
        print(f"  haiku uncached input/ep min/median/max: {sorted(r['usage']['inputTokens'] for r in h)[0]}, {sorted(r['usage']['inputTokens'] for r in h)[len(h)//2]}, {max(r['usage']['inputTokens'] for r in h)}")
        print(f"  total $ {sum(usd(r) for r in recs):.4f}")
        print()


main()
