# Milestone: v17 on the held-out summit tiers (2026-11-01)

Projection mode only, box descriptions on. Haiku 4 reps, Sonnet 2 reps.
Spend: $18.80. Compared with the basecamp calibration (direct, v13; 2 reps)
and the v15 milestone (2 reps).

| tier | model | direct | v13 | v15 | v17 |
|---|---|---|---|---|---|
| summit-local | haiku45 | 70.8% $0.0267 | 79.2% $0.0267 | 75.0% $0.0273 | 71.9% $0.0275 |
| summit-saas | haiku45 | 83.3% $0.0561 | 79.2% $0.0620 | 72.9% $0.0580 | 77.1% $0.0591 |
| summit-messy | haiku45 | 83.3% $0.0374 | 88.1% $0.0302 | 83.3% $0.0277 | 86.9% $0.0265 |
| summit-local | sonnet-low | 95.8% $0.0445 | 97.9% $0.0518 | 100% $0.0534 | 95.8% $0.0511 |
| summit-saas | sonnet-low | 97.9% $0.1370 | 100% $0.1166 | 100% $0.0881 | 100% $0.0927 |
| summit-messy | sonnet-low | 97.6% $0.0838 | 100% $0.0445 | 100% $0.0311 | 100% $0.0323 |

Totals: Sonnet v17 136/138 (98.6%) at 0.67x direct's cost (direct 97.1%,
v13 0.81x, v15 0.66x). Haiku v17 216/276 (78.3%) at 0.95x (direct 79.0%,
v13 81.9% at 1.00x, v15 76.8% at 0.95x).

Reading: on unseen servers the v14-v17 gains hold for Sonnet as cost (a
third cheaper than direct, at a higher pass rate) and do not move Haiku.
Haiku sits at direct's pass rate for 5% less. Its failures are the tasks
the summit audit classed as model failures in every mode (date and money
arithmetic, filters), not facade mechanics. The Haiku pass rate went
v13 81.9% -> v15 76.8% -> v17 78.3%. v13 had 2 reps, so this is noise around
about 78-80%, not a trend. summit-local (small tool sets) is still dearer
than direct for Sonnet (1.15x).

No design decision may be drawn from individual summit failures.
