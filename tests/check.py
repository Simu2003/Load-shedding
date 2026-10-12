"""Independent rule checker (does not import solver): check(input, output) -> list of problems."""
def check(inp, out):
    bad = []
    if out.get("status") != "ok":
        return bad
    cap = inp["generator_capacity_kw"]; budget = round(float(inp["fuel_budget_litres"]) * 100)
    table = [(r["load_kw"], round(float(r["litres_per_hour"]) * 100)) for r in inp["fuel_table"]]
    shops = {s["id"]: s for s in inp["shops"]}
    outage = [t for t, g in enumerate(inp["grid_available"]) if not g]
    if [r["slot"] for r in out["roster"]] != outage: bad.append("roster hours != outage hours")
    run = {k: 0 for k in shops}; dh = {k: 0 for k in shops}; fuel = 0; value = 0
    by = {r["slot"]: r for r in out["roster"]}
    for t in range(10):
        if inp["grid_available"][t]:
            run = {k: 0 for k in shops}; continue
        r = by[t]; on = set(r["powered"]); dk = {d["id"] for d in r["dark"]}
        if on & dk or on | dk != set(shops): bad.append(f"slot {t}: powered/dark not a partition")
        load = sum(shops[i]["kw"] for i in on)
        if load > cap: bad.append(f"slot {t}: load {load} > cap")
        f = 0 if load == 0 else next(h for l, h in table if l >= load)
        fuel += f
        value += sum(shops[i]["value_per_slot"][t] for i in on)
        for k, s in shops.items():
            if k in on: run[k] = 0
            else:
                run[k] += 1; dh[k] += 1
                if s["type"] == "mandatory": bad.append(f"slot {t}: mandatory {k} dark")
                if run[k] > inp["max_consecutive_dark"]: bad.append(f"slot {t}: {k} dark run {run[k]}")
        for d in r["dark"]:
            if not d.get("reason"): bad.append(f"slot {t}: {d['id']} no reason")
    if fuel > budget: bad.append(f"fuel {fuel} > budget {budget}")
    if value != out["value_total"]: bad.append(f"value {value} != reported {out['value_total']}")
    if abs(fuel / 100 - out["fuel_total_litres"]) > 1e-9: bad.append("fuel total mismatch")
    if dh != out["dark_hours"]: bad.append("dark_hours mismatch")
    return bad

if __name__ == "__main__":
    import sys, json
    p = check(json.load(open(sys.argv[1])), json.load(open(sys.argv[2])))
    print("OK" if not p else p)
