import json,sys,collections
sys.argv=sys.argv
P={'claude-haiku-4-5':(1,5),'claude-sonnet-5-5':(2,10)}
def usd(r):
  u=r['usage'];p=P[r['modelId']]
  return ((u['inputTokens']+u['cacheReadInputTokens']*0.1+u['cacheCreationInputTokens']*1.25)*p[0]+u['outputTokens']*p[1])/1e6
runs={
 'B-forced':'B-forced.json',
 'B-unforced':'B-unforced.json',
 'A-forced':'A-forced.json',
 'A-unforced':'A-unforced.json',
 'A2-forced-haiku':'A2-forced-haiku.json',
 'A3-forced-sonnet':'A3-forced-sonnet.json',
 'A3-unforced-spot':'A3-unforced-spot.json',
}
WRITE={'hard-label-stale-issues','hard-comment-export-prs','hard-audit-shipped-orders','hard-branch-failing-checks','hard-branch-vip-tiers'}
allr=[]
tot=0
for name,f in runs.items():
  d=json.load(open(f))
  for r in d['records']:
    r['_run']=name; r['_usd']=usd(r); tot+=r['_usd']; allr.append(r)
print('TOTAL SPEND', round(tot,4))
def em(r): return [u for u in r['toolUses'] if u['name']=='execute_machine']
def summary(rs):
  n=len(rs); s=sum(r['success'] for r in rs); c=sum(r['_usd'] for r in rs)
  return f"{s}/{n} | ${c:.3f} | ${c/n:.4f} | {('$%.4f'%(c/s)) if s else '-'} | {sum(r['apiTurns'] for r in rs)/n:.1f} | {sum((r['projection'].get('roundTrips') or 0) for r in rs)/n:.1f}"
print('| run | model | pass | $ | $/ep | $/success | turns/ep | round trips/ep |')
for name in runs:
  for m in ('haiku45','sonnet-low'):
    rs=[r for r in allr if r['_run']==name and r['model']==m]
    if rs: print(f'| {name} | {m} | '+summary(rs)+' |')
print()
print('write+branch tasks only')
for name in runs:
  for m in ('haiku45','sonnet-low'):
    rs=[r for r in allr if r['_run']==name and r['model']==m and r['task'] in WRITE]
    if rs: print(f'| {name} | {m} | '+summary(rs)+' |')
print()
# by route (pure execute_machine-led vs call_tool only), before vs after
def route(r):
  rt=r['projection']['route']
  return rt
print('by route; "after" = A-* runs')
for era in ('B','A'):
  for rt in ('call_tool','both','execute_machine'):
    for m in ('haiku45','sonnet-low'):
      rs=[r for r in allr if r['_run'].startswith(era) and r['model']==m and route(r)==rt]
      if rs: print(f'| {era} | {rt} | {m} | '+summary(rs)+' |')
print()
# write tasks: cost per success by "writes done in machine" vs call_tool
def writes_in_machine(r):
  # machine round trips used for approvals: approvals > roundTrips implies batching
  p=r['projection']; return (p.get('roundTrips') or 0) < p['approvals']
print('write tasks, after runs: batched-in-machine vs not')
for m in ('haiku45','sonnet-low'):
  for k in (True,False):
    rs=[r for r in allr if r['_run'].startswith('A') and r['model']==m and r['task'] in WRITE and writes_in_machine(r)==k]
    if rs: print(f'| {m} | fan-out={k} | '+summary(rs)+' |')
for m in ('haiku45','sonnet-low'):
  rs=[r for r in allr if r['_run']=='B-unforced' and r['model']==m and r['task'] in WRITE and r['projection']['route']=='call_tool']
  if rs: print(f'| {m} | B-unforced call_tool-only | '+summary(rs)+' |')
