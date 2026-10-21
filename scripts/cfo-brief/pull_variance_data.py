#!/usr/bin/env python3
"""
Pull data for the Asthetik monthly variance brief (design v1, Controller seat).

Two data sources:
  1. BI-ARInvoices (line-grain GI via gateway) — ExtAmount, ExtCost, ExtProfit,
     CustomerID, CustomerClassID, OrderType, Branch, Salesperson.
     The line grain enables margin-by-channel decomposition.
  2. StockItem (Contract-REST via gateway) — LastCost per item for inventory
     cost-side valuation. Qty must come from wms_inventory (bolt-wms DB),
     pulled conditionally if DATABASE_PUBLIC_URL is set.

Env: ACUMATICA_GATEWAY_URL, ACUMATICA_GATEWAY_TOKEN.
Opt: DATABASE_URL (bolt-wms hf_prod) for wms_inventory qty.
Usage: pull_variance_data.py --period MMYYYY --workdir DIR

Laws: bare query params (#181); gateway error envelope detection; 429
Retry-After (#437); other failures retry once then exit (#161); exact-page
continuation with page-cap WARN (#331).
"""
import argparse, json, os, random, sys, time, urllib.parse, urllib.request

PAGE = 1000
PAGE_CAP = 10
INQUIRY_SELECT = (
    "ExtAmount,ExtCost,ExtProfit,CustomerID,CustomerClassID,"
    "OrderType,BranchID,SalespersonID,InvoiceNbr,DocDate,"
    "InventoryID,TranDesc,CuryDocBal,FinancialPeriod"
)
STOCKITEM_SELECT = "InventoryID,LastCost,AverageCost,ItemClassID,ItemStatus"


def fetch(path, params):
    base = os.environ["ACUMATICA_GATEWAY_URL"].rstrip("/")
    tok = os.environ["ACUMATICA_GATEWAY_TOKEN"]
    url = f"{base}/api/v1/acumatica/{path}?{urllib.parse.urlencode(params)}"
    last_err = None
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read().decode()
            data = json.loads(body)
            if isinstance(data, dict) and data.get("error"):
                raise RuntimeError(f"gateway error envelope: {body[:200]}")
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                ra = int(e.headers.get("Retry-After") or 30)
                wait = min(ra, 60) + random.uniform(0, 5)
                print(f"[pull_var] 429 pool_saturated — waiting {wait:.0f}s (#437)", flush=True)
            else:
                wait = 60
                print(f"[pull_var] HTTP {e.code} on {path} attempt {attempt} — waiting {wait}s", flush=True)
            last_err = e
            if attempt == 1:
                time.sleep(wait)
        except Exception as e:
            last_err = e
            print(f"[pull_var] {type(e).__name__}: {e} on {path} attempt {attempt}", flush=True)
            if attempt == 1:
                time.sleep(60)
    raise SystemExit(f"PULL FAILED after retry: {path}: {last_err}")


def pull_all(entity, select, flt):
    rows, skip, page = [], 0, 0
    while page < PAGE_CAP:
        params = {"select": select, "top": PAGE, "skip": skip}
        if flt:
            params["filter"] = flt
        batch = fetch(f"query/{entity}", params)
        rows.extend(batch)
        print(f"[pull_var] {entity} page {page}: {len(batch)} rows", flush=True)
        if len(batch) < PAGE:
            return rows
        skip += PAGE
        page += 1
    print(f"[pull_var] **WARN: {entity} hit the {PAGE_CAP}-page cap — population may be truncated (#331)**", flush=True)
    return rows


def pull_inquiry(gi_name, select, flt):
    rows, skip, page = [], 0, 0
    while page < PAGE_CAP:
        params = {"select": select, "top": PAGE, "skip": skip}
        if flt:
            params["$filter"] = flt
        batch = fetch(f"inquiry/{gi_name}", params)
        vals = batch.get("value", batch) if isinstance(batch, dict) else batch
        rows.extend(vals)
        print(f"[pull_var] {gi_name} page {page}: {len(vals)} rows", flush=True)
        if len(vals) < PAGE:
            return rows
        skip += PAGE
        page += 1
    print(f"[pull_var] **WARN: {gi_name} hit the {PAGE_CAP}-page cap (#331)**", flush=True)
    return rows


def pull_wms_inventory(workdir):
    db_url = os.environ.get("DATABASE_URL") or os.environ.get("DATABASE_PUBLIC_URL")
    if not db_url:
        print("[pull_var] wms_inventory: no DATABASE_URL/DATABASE_PUBLIC_URL — skipping qty pull", flush=True)
        return

    import subprocess
    sql = (
        "SELECT inventory_id, SUM(qty_on_hand) AS qty_on_hand, SUM(qty_available) AS qty_available "
        "FROM hf_prod.wms_inventory "
        "WHERE qty_on_hand IS NOT NULL "
        "GROUP BY inventory_id"
    )
    try:
        out = subprocess.run(
            ["psql", db_url, "-tAc", sql],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0:
            print(f"[pull_var] wms_inventory: psql failed (rc={out.returncode}): {out.stderr[:200]}", flush=True)
            return
        rows = []
        for line in out.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split("|")
            if len(parts) >= 2:
                try:
                    rows.append({"inventory_id": parts[0].strip(), "qty_on_hand": float(parts[1]), "qty_available": float(parts[2])})
                except (ValueError, IndexError):
                    pass
        path = os.path.join(workdir, "wms-inventory.json")
        json.dump(rows, open(path, "w"))
        print(f"[pull_var] wms_inventory: {len(rows)} items with qty -> {path}", flush=True)
    except FileNotFoundError:
        print("[pull_var] wms_inventory: psql not found — skipping qty pull", flush=True)
    except Exception as e:
        print(f"[pull_var] wms_inventory: {type(e).__name__}: {e}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Pull data for Asthetik monthly variance brief")
    ap.add_argument("--period", required=True, help="MMYYYY, e.g. 092026")
    ap.add_argument("--workdir", required=True)
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)

    inv_rows = pull_inquiry(
        "BI-ARInvoices",
        INQUIRY_SELECT,
        f"FinancialPeriod eq '{a.period}'",
    )
    inv_path = os.path.join(a.workdir, f"bi-arinvoices-{a.period}.json")
    json.dump(inv_rows, open(inv_path, "w"))
    print(f"[pull_var] BI-ARInvoices {a.period}: {len(inv_rows)} rows -> {inv_path}", flush=True)

    stock_items = pull_all("StockItem", STOCKITEM_SELECT, None)
    stock_path = os.path.join(a.workdir, "stockitem-snapshot.json")
    json.dump(stock_items, open(stock_path, "w"))
    nz = sum(1 for r in stock_items if float(r.get("LastCost") or 0) > 0)
    print(f"[pull_var] StockItem: {len(stock_items)} items ({nz} with LastCost>0) -> {stock_path}", flush=True)

    pull_wms_inventory(a.workdir)


if __name__ == "__main__":
    main()