# Milestone: v15 on the held-out summit tiers (2026-10-31)

Projection mode only, both models, 2 reps, box descriptions on. Compared with the
basecamp calibration run of v13 and direct mode (same tiers, same reps).
Spend: $13.37.

| tier         | model      | direct        | v13           | v15           |
| ------------ | ---------- | ------------- | ------------- | ------------- |
| summit-local | haiku45    | 34/48 $0.0267 | 38/48 $0.0267 | 36/48 $0.0273 |
| summit-local | sonnet-low | 46/48 $0.0445 | 47/48 $0.0518 | 48/48 $0.0534 |
| summit-saas  | haiku45    | 40/48 $0.0561 | 38/48 $0.0620 | 35/48 $0.0580 |
| summit-saas  | sonnet-low | 47/48 $0.1370 | 48/48 $0.1166 | 48/48 $0.0881 |
| summit-messy | haiku45    | 35/42 $0.0374 | 37/42 $0.0302 | 35/42 $0.0277 |
| summit-messy | sonnet-low | 41/42 $0.0838 | 42/42 $0.0445 | 42/42 $0.0311 |

Totals (pass, cost relative to direct): Sonnet direct 134/138 1.00x, v13 137/138
0.81x, v15 138/138 0.66x. Haiku direct 109/138 1.00x, v13 113/138 1.00x, v15
106/138 0.95x.

Reading: the D32/D33 turn cuts carry over to unseen servers for Sonnet (saas
-24%, messy -30% vs v13). Haiku cost moves little and its pass count is down 7 vs
v13. That is about 1 SD of the difference at 2 reps, spread over different tasks,
so it is not yet a signal; the next milestone runs Haiku at 4 reps. Haiku still
takes ~9 turns on summit-saas against 4.9 direct. summit-local (small tool sets,
all listed directly) stays dearer than direct for both models.

No design decision may be drawn from individual summit failures.
