# Evidence

**Bug found and fixed (bug1_*)** - `bug1_input.json` is the 5-shop worked example from the brief (known optimum 84).
While adding a dead-end prune (skip a state if next hour's forced shops cannot fit the fuel left) I counted next
hour's base fuel twice. Result: the optimiser wrongly discarded the best plan and returned **81**
(`bug1_old_output.json`). Caught because the worked example says 84. Fix: `nf + fuel_at[mload+fk] + minrem[t+2] > budget`
(`bug1_fixed_output.json` = 84, 8.00 L). The brute-force comparison in `tests/brute.py` now guards this.

**Boundary checks (boundary_*)** - each `*_input.json` has its `*_output.json`, produced by POST /api/roster:
| file | what it probes | result |
|---|---|---|
| boundary_exact_budget | plan uses exactly the 8.00 L budget | ok, 84, 8.00 |
| boundary_no_outage | all grid hours | ok, empty roster, zeros |
| boundary_mandatory_exceeds_capacity | mandatory 11 kW > 10 kW | infeasible (capacity) |
| boundary_tight_fuel | budget 2.4 L < mandatory-only need | infeasible (fuel) |
| boundary_invalid_three_decimals | 8.005 litres | HTTP 400 invalid_input |

Re-run: `python tests/rerun_evidence.py` (server on :8000).
