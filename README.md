# Who Stays On? - Shapla Shopping Complex roster

## Start
    python app.py            # Python 3.8+, standard library only, no internet
Open **http://localhost:8000** (set `PORT=9000` to change). Nothing to install.

## Where things are
| file | role |
|---|---|
| `solver.py` | **all decision logic**: `validate()` -> `solve()` -> `_optimize()` (the DP) -> `_build_block()` (totals + reasons) |
| `app.py` | HTTP server. `POST /api/roster` (200 ok/infeasible, 400 invalid_input) + serves the screen |
| `static/index.html`, `static/app.css`, `static/app.js` | the screen (no framework, no CDN, no web fonts). `app.js` only sends the input to `POST /api/roster` and draws the answer; it decides nothing |
| `solve_file.py` | `python solve_file.py in.json out.json` - same code path as the API, for scripts |
| `tests/check.py` | independent rule checker; `tests/brute.py` compares the solver with exhaustive search |
| `evidence/` | bug found + fixed, boundary inputs/outputs (`python tests/rerun_evidence.py`) |
| `outputs/` | `sample_output.json` (practice input), `update150_output.json` (minute-150 input) |

## How the solver thinks (2-minute version)
1. Mandatory shops are on in every outage hour; their kW and fuel are a fixed base.
2. For each outage hour every set of normal shops that fits the generator is a candidate; fuel is looked up **once from the combined load** (rounded up to the next table level), in whole hundredths of a litre.
3. One dynamic programme over the 10 hours. State = (dark-run length of each normal shop, diesel used) -> best value. A shop whose run equals `max_consecutive_dark` is forced on; grid hours reset runs. So the diesel is planned across the day, never spent greedily at noon.
4. Exact pruning: Lagrangian bound (value - lambda*litres) + a beam-search incumbent + "maximal sets only" (a subset with the same fuel is never better). Result is the true optimum; an 8 s safety deadline falls back to the beam result.
5. Every dark cell gets a reason built from the final roster: capacity (load a->b > limit), diesel (day total would exceed budget), or zero value, plus the dark-run count.
6. Infeasible = named rule + shops + hours (mandatory > capacity, mandatory fuel > budget, a too-big shop dark longer than the limit, or generic), with a labelled best-effort roster when one exists.

## Minute-150 update
Paste/upload the new file on the screen, or `python -c "import app,sys;print(app.roster_endpoint(open('new.json','rb').read())[1])"`; save as `outputs/update150_output.json`.

## The screen
- **Day strip**: click an hour to flip grid <-> outage, or edit capacity / diesel / longest dark run; the roster is re-planned through the API (this is the quickest way to try the minute-150 change).
- **Roster board**: lit amber window = powered (check), dark window = cut (cross), hatched = grid hour. Mandatory shops are first and starred. Under the board: load vs capacity, fuel per hour, running diesel vs budget.
- **Why dark**: hover / focus / click a cross for the reason; the list below groups every reason by shop (Diesel / Capacity, with the dark-run count).
- **Load input**: file chooser, paste, or drop a file anywhere. **Download output JSON** saves the API response.
- **Print for the door**: A4 landscape, one page: board, loads and fuel, black-and-white safe.
- Infeasible: the conflicting rule, shops and hours are shown; the labelled best-effort board outlines in red any shop whose dark run breaks the limit.

## Minute-150 update
Load the new file on the screen (or `python solve_file.py update150.json outputs/update150_output.json`) and commit `outputs/update150_output.json`.
