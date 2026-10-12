"""
Who Stays On? -- the decision logic lives in this file.

Public entry point:  solve(input_dict) -> output_dict   (raises InvalidInput)

Method (one plan for the whole day, not hour-by-hour greed):
  * Mandatory shops are always on in outage hours (their load/fuel is a constant).
  * Normal shops are bits of a mask.  For every outage hour we enumerate every
    mask that fits the generator.  Fuel is looked up ONCE from the combined load.
  * Dynamic programme over the 10 hours.  State = (dark-run length of every
    normal shop, diesel used so far in hundredths of a litre) -> best value.
    A shop whose run already equals max_consecutive_dark is FORCED on.
    Grid hours reset all runs.
  * Pruning is exact: a Lagrangian upper bound (value - lambda*fuel) for the
    remaining hours, compared against an incumbent found by a quick beam search.
    Result is the true optimum (unless the 8 s safety deadline hits; then the
    beam result is returned).
"""
import time
from decimal import Decimal

SLOTS = 10
INCLUDE_EXTRAS = True       # load_kw / fuel_litres per hour in roster entries (for the screen)


class InvalidInput(Exception):
    pass


class _Timeout(Exception):
    pass


# --------------------------------------------------------------------------- validation
def _isint(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _hundredths(x, field):
    if isinstance(x, bool) or not isinstance(x, (int, Decimal)):
        raise InvalidInput(f"{field}: must be a number")
    d = Decimal(x)
    if d < 0:
        raise InvalidInput(f"{field}: must not be negative")
    if d > Decimal(10 ** 6):
        raise InvalidInput(f"{field}: unreasonably large")
    if d != d.quantize(Decimal("0.01")):
        raise InvalidInput(f"{field}: more than two decimal places")
    return int(d * 100)


def validate(d):
    if not isinstance(d, dict):
        raise InvalidInput("input: top level must be a JSON object")
    for k in ("grid_available", "generator_capacity_kw", "fuel_budget_litres",
              "fuel_table", "max_consecutive_dark", "shops"):
        if k not in d:
            raise InvalidInput(f"{k}: missing field")

    g = d["grid_available"]
    if not isinstance(g, list) or len(g) != SLOTS:
        raise InvalidInput(f"grid_available: must be a list of exactly {SLOTS} booleans")
    for i, v in enumerate(g):
        if not isinstance(v, bool):
            raise InvalidInput(f"grid_available[{i}]: must be true or false")

    cap = d["generator_capacity_kw"]
    if not _isint(cap) or cap <= 0:
        raise InvalidInput("generator_capacity_kw: must be a positive whole number")

    budget = _hundredths(d["fuel_budget_litres"], "fuel_budget_litres")

    ft = d["fuel_table"]
    if not isinstance(ft, list) or not ft:
        raise InvalidInput("fuel_table: must be a non-empty list")
    table, prev = [], 0
    for i, row in enumerate(ft):
        if not isinstance(row, dict) or "load_kw" not in row or "litres_per_hour" not in row:
            raise InvalidInput(f"fuel_table[{i}]: needs load_kw and litres_per_hour")
        lk = row["load_kw"]
        if not _isint(lk) or lk <= 0:
            raise InvalidInput(f"fuel_table[{i}].load_kw: must be a positive whole number")
        if lk <= prev:
            raise InvalidInput(f"fuel_table[{i}].load_kw: levels must be strictly increasing")
        prev = lk
        table.append((lk, _hundredths(row["litres_per_hour"], f"fuel_table[{i}].litres_per_hour")))
    if table[-1][0] != cap:
        raise InvalidInput("fuel_table: last load_kw must equal generator_capacity_kw")

    maxd = d["max_consecutive_dark"]
    if not _isint(maxd) or maxd < 0:
        raise InvalidInput("max_consecutive_dark: must be a whole number >= 0")

    sh = d["shops"]
    if not isinstance(sh, list):
        raise InvalidInput("shops: must be a list")
    if len(sh) > 12:
        raise InvalidInput("shops: at most 12 shops allowed")
    shops, seen = [], set()
    for i, s in enumerate(sh):
        p = f"shops[{i}]"
        if not isinstance(s, dict):
            raise InvalidInput(f"{p}: must be an object")
        for k in ("id", "kw", "type", "value_per_slot"):
            if k not in s:
                raise InvalidInput(f"{p}.{k}: missing field")
        sid = s["id"]
        if not isinstance(sid, str) or not sid.strip():
            raise InvalidInput(f"{p}.id: must be a non-blank string")
        if sid in seen:
            raise InvalidInput(f"{p}.id: duplicate id '{sid}'")
        seen.add(sid)
        if not _isint(s["kw"]) or s["kw"] <= 0:
            raise InvalidInput(f"{p}.kw: must be a positive whole number")
        if s["type"] not in ("mandatory", "normal"):
            raise InvalidInput(f"{p}.type: must be 'mandatory' or 'normal'")
        v = s["value_per_slot"]
        if not isinstance(v, list) or len(v) != SLOTS:
            raise InvalidInput(f"{p}.value_per_slot: must be a list of exactly {SLOTS} numbers")
        for j, x in enumerate(v):
            if not _isint(x) or x < 0:
                raise InvalidInput(f"{p}.value_per_slot[{j}]: must be a whole number >= 0")
        shops.append({"idx": i, "id": sid, "kw": s["kw"], "type": s["type"], "vals": list(v)})

    fuel_at = [0] * (cap + 1)
    for load in range(1, cap + 1):
        for lk, lh in table:
            if lk >= load:
                fuel_at[load] = lh
                break
    return {"grid": list(g), "cap": cap, "budget": budget, "fuel_at": fuel_at,
            "maxd": maxd, "shops": shops}


# --------------------------------------------------------------------------- optimiser
def _optimize(P, hours, maxd, deadline, beam, incumbent):
    """Return (normal_value, {slot: mask}) or None.  Bits refer to P['norm']."""
    cap, budget, fuel_at = P["cap"], P["budget"], P["fuel_at"]
    norm, mload = P["norm"], P["mload"]
    n = len(norm)
    N = 1 << n
    kws = [s["kw"] for s in norm]
    kwsum = [0] * N
    for m in range(1, N):
        low = m & -m
        kwsum[m] = kwsum[m ^ low] + kws[low.bit_length() - 1]
    room = cap - mload
    ok = [m for m in range(N) if kwsum[m] <= room]

    cands = {}
    for t in hours:
        vs = [0] * N
        for m in range(1, N):
            low = m & -m
            vs[m] = vs[m ^ low] + norm[low.bit_length() - 1]["vals"][t]
        # keep only masks that are maximal for their fuel level: adding any other shop would
        # exceed capacity or cost more diesel.  A subset with the same fuel is never better
        # (values >= 0, and powering a shop never lengthens a dark run), so nothing is lost.
        cl = []
        for m in ok:
            ld = mload + kwsum[m]
            fu = fuel_at[ld]
            if all((m >> i) & 1 or ld + kws[i] > cap or fuel_at[ld + kws[i]] > fu for i in range(n)):
                cl.append((m, fu, vs[m]))
        cands[t] = cl

    # Lagrangian multipliers
    lmax = 0.0
    for t in hours:
        base = fuel_at[mload]
        for m, fu, v in cands[t]:
            if fu > base:
                lmax = max(lmax, v / ((fu - base) / 100.0))
    lams = [0.0] if lmax == 0 else [lmax * k / 24.0 for k in range(26)]
    g = {t: [max(v - lam * fu / 100.0 for m, fu, v in cands[t]) for lam in lams] for t in hours}
    S = [[0.0] * (SLOTS + 1) for _ in lams]
    for j in range(len(lams)):
        for t in range(SLOTS - 1, -1, -1):
            S[j][t] = S[j][t + 1] + (g[t][j] if t in g else 0.0)
    minrem = [0] * (SLOTS + 2)
    for t in range(SLOTS - 1, -1, -1):
        minrem[t] = minrem[t + 1] + (fuel_at[mload] if t in cands else 0)
    js = min(range(len(lams)), key=lambda j: S[j][0] + lams[j] * budget / 100.0)
    lam_s, S_s = lams[js], S[js]

    def bound(v, f, t):
        return min(v + S[j][t] + lams[j] * (budget - f) / 100.0 for j in range(len(lams)))

    thresh = incumbent + 1 - 1e-9
    states = {((0,) * n, 0): (0, None)}
    cnt = 0
    for t in range(SLOTS):
        if t not in cands:                      # grid hour: everybody powered, runs reset
            new = {}
            for (runs, f), (v, node) in states.items():
                key = ((0,) * n, f)
                if key not in new or new[key][0] < v:
                    new[key] = (v, node)
            states = new
            continue
        new = {}
        cl = cands[t]
        mr = minrem[t + 1]
        sb = S_s[t + 1]
        nxt_outage = (t + 1) in cands
        for (runs, f), (v, node) in states.items():
            forced = 0
            for i in range(n):
                if runs[i] >= maxd:
                    forced |= 1 << i
            for m, fu, val in cl:
                if m & forced != forced:
                    continue
                nf = f + fu
                if nf + mr > budget:
                    continue
                nv = v + val
                if nv + sb + lam_s * (budget - nf) / 100.0 < thresh:
                    continue
                cnt += 1
                if (cnt & 2047) == 0 and time.time() > deadline:
                    raise _Timeout()
                nr = tuple(0 if (m >> i) & 1 else runs[i] + 1 for i in range(n))
                if nxt_outage:                      # dead-end check: next hour's forced shops must fit
                    fk = 0
                    for i in range(n):
                        if nr[i] >= maxd:
                            fk += kws[i]
                    if fk > room or nf + fuel_at[mload + fk] + minrem[t + 2] > budget:
                        continue
                key = (nr, nf)
                old = new.get(key)
                if old is None or old[0] < nv:
                    new[key] = (nv, (node, t, m))
        # dominance inside same run-vector: more fuel must buy more value
        groups = {}
        for (runs, f), (v, node) in new.items():
            groups.setdefault(runs, []).append((f, v, node))
        kept = []
        for runs, lst in groups.items():
            lst.sort(key=lambda x: (x[0], -x[1]))
            best = -1
            for f, v, node in lst:
                if v > best:
                    best = v
                    kept.append((bound(v, f, t + 1), runs, f, v, node))
        kept = [k for k in kept if k[0] >= thresh]
        if beam and len(kept) > beam:
            kept.sort(key=lambda k: -k[0])
            kept = kept[:beam]
        states = {(runs, f): (v, node) for _, runs, f, v, node in kept}
        if not states:
            return None
    if not states:
        return None
    (runs, f), (v, node) = max(states.items(), key=lambda kv: (kv[1][0], -kv[0][1]))
    assign = {}
    while node is not None:
        node, t, m = node
        assign[t] = m
    return v, assign


# --------------------------------------------------------------------------- explanations
def _fmt(h):
    return f"{h / 100:.2f}"


def _build_block(P, powered):
    """powered: {slot: set(shop idx)} for outage slots.  Recomputes everything from scratch."""
    shops, fuel_at, cap, budget = P["shops"], P["fuel_at"], P["cap"], P["budget"]
    maxd = P["maxd"]
    info, total_f, total_v = {}, 0, 0
    for t in sorted(powered):
        pw = powered[t]
        load = sum(s["kw"] for s in shops if s["idx"] in pw)
        fu = fuel_at[load]
        total_f += fu
        total_v += sum(s["vals"][t] for s in shops if s["idx"] in pw)
        info[t] = (load, fu)
    run = {s["id"]: 0 for s in shops}
    dark_hours = {s["id"]: 0 for s in shops}
    roster, cum = [], 0
    for t in range(SLOTS):
        if P["grid"][t]:
            for k in run:
                run[k] = 0
            continue
        pw = powered[t]
        load, fu = info[t]
        cum += fu
        on, dark = [], []
        for s in shops:
            if s["idx"] in pw:
                run[s["id"]] = 0
                on.append(s["id"])
                continue
            run[s["id"]] += 1
            dark_hours[s["id"]] += 1
            nl = load + s["kw"]
            if P["mload"] + s["kw"] > cap:
                why = (f"Capacity: {s['kw']} kW does not fit beside the mandatory shops "
                       f"({P['mload']} kW) within the {cap} kW generator - it can never run on the generator.")
            elif nl > cap:
                why = (f"Capacity: adding it would raise the load from {load} kW to {nl} kW, "
                       f"above the {cap} kW generator limit.")
            else:
                extra = fuel_at[nl] - fu
                if total_f + extra > budget:
                    why = (f"Diesel: adding it moves load {load}->{nl} kW, this hour {_fmt(fu)}->{_fmt(fuel_at[nl])} L; "
                           f"day total would be {_fmt(total_f + extra)} L > budget {_fmt(budget)} L. "
                           f"Those litres earn more value in other hours.")
                elif s["vals"][t] == 0:
                    why = "No value: it is worth 0 in this hour, so powering it gains nothing."
                else:
                    why = (f"Trade-off: plan keeps diesel for higher-value hours "
                           f"(this hour is worth {s['vals'][t]}).")
            why += f" Dark run so far: {run[s['id']]} (max {maxd})."
            dark.append({"id": s["id"], "reason": why})
        entry = {"slot": t, "time": f"{10 + t:02d}:00", "powered": on, "dark": dark}
        if INCLUDE_EXTRAS:
            entry["load_kw"] = load
            entry["fuel_litres"] = round(fu / 100, 2)
            entry["fuel_cumulative_litres"] = round(cum / 100, 2)
        roster.append(entry)
    return {"roster": roster, "value_total": total_v,
            "fuel_total_litres": round(total_f / 100, 2), "dark_hours": dark_hours}


def _runs_of_outage(P):
    """maximal blocks of consecutive outage slots"""
    blocks, cur = [], []
    for t in range(SLOTS):
        if not P["grid"][t]:
            cur.append(t)
        elif cur:
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)
    return blocks


def _times(ts):
    return [f"{10 + t:02d}:00" for t in ts]


def _infeasible(rule, shops, hours, msg, best=None):
    out = {"status": "infeasible",
           "conflict": {"rule": rule, "shops": shops, "hours": _times(hours), "message": msg}}
    if best is not None:
        out["best_effort"] = best
    return out


# --------------------------------------------------------------------------- main
def solve(inp, time_limit=8.0):
    start = time.time()
    P = validate(inp)
    shops, cap, budget, fuel_at = P["shops"], P["cap"], P["budget"], P["fuel_at"]
    hours = [t for t in range(SLOTS) if not P["grid"][t]]
    mand = [s for s in shops if s["type"] == "mandatory"]
    norm = [s for s in shops if s["type"] == "normal"]
    P["norm"] = norm
    P["mload"] = mload = sum(s["kw"] for s in mand)
    mand_idx = {s["idx"] for s in mand}

    if not hours:
        return {"status": "ok", "roster": [], "value_total": 0, "fuel_total_litres": 0.0,
                "dark_hours": {s["id"]: 0 for s in shops}}

    # --- certain conflicts, named precisely
    if mload > cap:
        return _infeasible("capacity", [s["id"] for s in mand], hours,
                           f"Mandatory shops need {mload} kW together in every outage hour but the generator "
                           f"carries {cap} kW.")
    need = fuel_at[mload] * len(hours)
    if need > budget:
        return _infeasible("fuel", [s["id"] for s in mand], hours,
                           f"Mandatory shops alone ({mload} kW -> {_fmt(fuel_at[mload])} L/h) need "
                           f"{_fmt(need)} L over {len(hours)} outage hours; budget is {_fmt(budget)} L.")
    best_pw = lambda: {t: set(mand_idx) for t in hours}
    for s in norm:
        if mload + s["kw"] > cap:
            for blk in _runs_of_outage(P):
                if len(blk) > P["maxd"]:
                    pw = best_pw()
                    best = _build_block(P, pw)
                    best["label"] = ("best effort (rules broken): only mandatory shops powered; "
                                     f"{s['id']} exceeds max_consecutive_dark")
                    return _infeasible("max_consecutive_dark", [s["id"]], blk,
                                       f"{s['id']} ({s['kw']} kW) cannot run beside the mandatory shops "
                                       f"({mload} kW) on a {cap} kW generator, yet it would be dark for "
                                       f"{len(blk)} consecutive outage hours (max {P['maxd']}).", best)

    # --- optimise
    deadline = start + time_limit
    result = None
    try:
        beam = _optimize(P, hours, P["maxd"], deadline, 300, -1)
    except _Timeout:
        beam = None
    inc = beam[0] if beam else -1
    ex = None
    try:
        ex = _optimize(P, hours, P["maxd"], deadline, None, inc)
    except _Timeout:
        ex = None
    result = ex if (ex and (not beam or ex[0] > beam[0])) else beam

    if result is None:
        # no roster obeys every rule: show best effort ignoring the dark-run rule
        relaxed = _optimize(P, hours, 99, time.time() + 3, 300, -1)
        best = None
        culprit = [s["id"] for s in norm]
        if relaxed:
            pw = {t: set(mand_idx) | {norm[i]["idx"] for i in range(len(norm)) if relaxed[1][t] >> i & 1}
                  for t in hours}
            best = _build_block(P, pw)
            best["label"] = "best effort (rules broken): ignores max_consecutive_dark"
        return _infeasible("fuel/capacity vs max_consecutive_dark", culprit, hours,
                           f"No roster satisfies capacity ({cap} kW), diesel ({_fmt(budget)} L) and "
                           f"max_consecutive_dark ({P['maxd']}) together: keeping every normal shop within its "
                           f"dark-run limit needs more kW or litres than available.", best)

    masks = result[1]
    powered = {t: set(mand_idx) | {norm[i]["idx"] for i in range(len(norm)) if masks[t] >> i & 1}
               for t in hours}
    out = {"status": "ok"}
    out.update(_build_block(P, powered))
    return out
