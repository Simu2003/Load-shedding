import json, random, itertools, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app, check
def brute(inp):
    cap=inp["generator_capacity_kw"]; B=round(inp["fuel_budget_litres"]*100)
    tab=[(r["load_kw"],round(r["litres_per_hour"]*100)) for r in inp["fuel_table"]]
    fu=lambda l: 0 if l==0 else next(h for k,h in tab if k>=l)
    sh=inp["shops"]; n=len(sh); md=inp["max_consecutive_dark"]
    out=[t for t,g in enumerate(inp["grid_available"]) if not g]
    mand=[i for i,s in enumerate(sh) if s["type"]=="mandatory"]
    best=[-1]
    def rec(k,runs,f,v):
        if f>B: return
        if k==10:
            best[0]=max(best[0],v); return
        if inp["grid_available"][k]: return rec(k+1,[0]*n,f,v)
        for mask in range(1<<n):
            if any(not mask>>i&1 for i in mand): continue
            l=sum(sh[i]["kw"] for i in range(n) if mask>>i&1)
            if l>cap: continue
            nr=[0 if mask>>i&1 else runs[i]+1 for i in range(n)]
            if any(nr[i]>md for i in range(n)): continue
            rec(k+1,nr,f+fu(l),v+sum(sh[i]["value_per_slot"][k] for i in range(n) if mask>>i&1))
    rec(0,[0]*n,0,0); return best[0]
random.seed(int(sys.argv[1]) if len(sys.argv)>1 else 1); bad=0; N=int(sys.argv[2]) if len(sys.argv)>2 else 60
for it in range(N):
    n=random.randint(1,4); cap=random.randint(4,12)
    lv=sorted(random.sample(range(1,cap),min(2,cap-1)))+[cap]; f=0; tab=[]
    for l in lv: f+=random.choice([40,60,80]); tab.append({"load_kw":l,"litres_per_hour":f/100})
    grid=[random.random()<0.45 for _ in range(10)]
    while sum(not g for g in grid)>6: grid[random.choice([i for i in range(10) if not grid[i]])]=True
    inp={"grid_available":grid,"generator_capacity_kw":cap,"fuel_budget_litres":round(random.uniform(1,6),2),
         "fuel_table":tab,"max_consecutive_dark":random.randint(1,3),
         "shops":[{"id":f"s{i}","kw":random.randint(1,5),"type":random.choice(["mandatory","normal","normal"]),
                   "value_per_slot":[random.randint(0,9) for _ in range(10)]} for i in range(n)]}
    code,o=app.roster_endpoint(json.dumps(inp).encode()); b=brute(inp)
    if o["status"]=="ok":
        p=check.check(json.loads(json.dumps(inp)),o)
        if p or o["value_total"]!=b: bad+=1; print("MISMATCH",it,o["value_total"],b,p); json.dump(inp,open(f"/tmp/bad{it}.json","w"))
    elif b!=-1: bad+=1; print("WRONG INFEASIBLE",it,b,o.get("conflict")); json.dump(inp,open(f"/tmp/bad{it}.json","w"))
print("done, mismatches:",bad,"of",N)
