#!/usr/bin/env python3
"""board.py — the sit-down surface. One screen: both cars, every stint, the flag panel,
who needs whom. Deterministic formatter over six state sources; the only model-in-the-loop
No external tool is read (Kevin 9/13: Toto is independent).

Usage (from /board):
  python3 board.py [--json] [--company studio-b|asthetik|all] [--race T1|all|backlog]

Sources:
  flags.md                                  open flags = rows in the FIRST table matching ^| **(SC|VSC|RED)**
  ~/.claude/state/shift-runner/<seat>.lock         lap in flight
  ~/.claude/state/shift-runner/<seat>.last-run.json  last lap start/status
  ~/.claude/state/shift-runner/<seat>.rearm-at       self-scheduled next wake
  ~/Library/LaunchAgents/com.studiob.shift-<seat>.plist  scheduled hours → MISSED SLOT detection
  seat-inbox pending <seat>                 undrained mail (no age clamp)
receipts/stints/<seat>.jsonl              stint receipts (burn is null until the ledger join, todo 93)
   receipts/races.jsonl                      race record — target_week, finish_line, stint_ids → burn/age/drift
   receipts/stints.jsonl                     THE stint queue (scripts/stint.py writes it)

Status vocabulary (F1-coded, 9/12): 🟢 racing (lap in flight or receipt <24h) · 🟡 STALLED (yellow — no
touch >48h, or a seat that missed its slot) · 🔵 BLOCKED (blue — tagged kevin / has blockers) ·
⚪ queued (filed, radioed, no lap yet) · 🏁 finished · 🔴 RED FLAG.
"""
import sys, argparse, datetime as dt, glob, json, os, plistlib, re, subprocess

HOME = os.path.expanduser("~")
SCRIPTS = os.path.dirname(os.path.abspath(__file__))

# card-lint.py is the one source of truth for card validation (#330) — import it by path (hyphens aren't valid Python identifiers)
import importlib.util as _iu
_card_lint_spec = _iu.spec_from_file_location("card_lint", os.path.join(SCRIPTS, "card-lint.py"))
_card_lint_mod = _iu.module_from_spec(_card_lint_spec)
_card_lint_spec.loader.exec_module(_card_lint_mod)
lint_card = _card_lint_mod.lint_card
STATE = os.path.join(HOME, ".claude/state/shift-runner")

# card_ok — imported from the standalone predicate module (stint #413)
_cok_spec = _iu.spec_from_file_location("card_ok", os.path.join(SCRIPTS, "card_ok.py"))
_cok_mod = _iu.module_from_spec(_cok_spec)
_cok_spec.loader.exec_module(_cok_mod)
card_ok = _cok_mod.card_ok
BRAIN = os.path.join(HOME, "Documents/brain")
AGENTS = os.path.join(HOME, "Library/LaunchAgents")
INBOX = os.path.join(HOME, ".claude/bin/seat-inbox")
NOW = dt.datetime.now(dt.timezone.utc)

# ONE SOURCE FOR NAMES (Kevin 9/13 05:5xZ: "the glass renders only what the record proves; anything hand-copied is a defect").
# ROSTER  = the runner's seats.yaml (pre-#98: shifts.yaml) — every seat with slots_utc, its role + team.  (the timetable IS the roster)
# TEAMS   = kits/<team>.yaml — display name, race engineer, live surfaces, radio.  (the kit IS the team)
# board.py publishes both into the glance; Toto reads the glance and holds NO names of its own.
def _load_roster():
    import yaml
    from runner_roster import roster_path   # ONE place knows where the runner's roster lives (see that module: the #98 rename
    y = yaml.safe_load(open(roster_path()))  # missed brain's cross-repo readers and froze the glass 2026-09-15 03:43Z)
    out = {}
    for k, v in (y.get("seats") or {}).items():
        if not isinstance(v, dict) or "slots_utc" not in v or k == "scout": continue
        slots = v.get("slots_utc") or []; on_demand = len(slots) == 0 or v.get("on_demand", False)
        out[k] = {"role": v.get("role") or k, "team": v.get("team") or "both", "slots_utc": slots, "rail": v.get("rail") or k, "on_demand": on_demand}
    return out
def _load_teams():
    import yaml
    out = {}
    for p in sorted(glob.glob(os.path.join(BRAIN, "kits", "*.yaml"))):
        if os.path.basename(p).startswith("_"): continue
        k = yaml.safe_load(open(p)) or {}; key = k.get("bay") or os.path.basename(p)[:-5]
        out[key] = {"key": key, "display": k.get("display") or key, "race_engineer": k.get("race_engineer"), "live_surfaces": k.get("live_surfaces") or [],
                    "radio": k.get("radio") or {}, "owner": k.get("owner"), "repos": k.get("repos") or []}
    return out
ROSTER = _load_roster(); TEAMS = _load_teams()
SEATS = {k: (v["team"], v["role"]) for k, v in ROSTER.items()}
COMPANY_LABEL = {k: v["display"].upper() for k, v in TEAMS.items()} | {"both": "GROUP"}

def iso(s):
    try: return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception: return None

def age(s):
    d = iso(s) if isinstance(s, str) else s
    if not d: return "—"
    m = int((NOW - d).total_seconds() // 60)
    return f"{m}m" if m < 90 else (f"{m//60}h" if m < 48*60 else f"{m//1440}d")

def sh(cmd, timeout=15):
    try: return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception: return ""

# ── crews (live launchd jobs, 2026-09-14 stint #329) ──────────────────────────
# com.studiob.crew.<seat>.<stint>.<lap> = a crew currently racing a stint.
# board.py reads these from launchctl list — the running process IS the fact,
# not a plist file (crew jobs are launched via launchctl submit, never loaded
# from ~/Library/LaunchAgents/). Reapers (.reaper) and heartbeat pulses (.pulse)
# are excluded. One stint may have multiple live laps (a re-drive launched a
# second crew before the first one exited); board.py keeps only the newest lap
# (longest running — the second lap is the one that overlapped both).
# Start time comes from ps, not a plist's st_mtime.
def load_crews():
    crews = []
    out = sh(["launchctl", "list"], timeout=10)
    for line in out.splitlines():
        if "com.studiob.crew." not in line: continue
        # line format: PID  EXIT_CODE  LABEL
        parts = line.strip().split()
        if len(parts) < 3: continue
        pid_str = parts[0]
        label = parts[2]
        if not pid_str.isdigit(): continue            # exited job with PID=—, never a live crew
        if label.endswith(".reaper") or label.endswith(".pulse"): continue   # exclude reapers + heartbeat pulses, never racing crews
        # label: com.studiob.crew.<seat>.<stint_id>.<lap_id>
        label_parts = label.split(".")
        if len(label_parts) < 5: continue
        seat = label_parts[3]
        try: stint_id = int(label_parts[4])
        except Exception: continue
        lap = label_parts[5] if len(label_parts) > 5 else ""
        started = None
        try:
            pid = int(pid_str)
            pout = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)],
                                  capture_output=True, text=True, timeout=5).stdout.strip()
            started = dt.datetime.strptime(pout, "%a %b %d %H:%M:%S %Y")
            # lstart is local on macOS — interpret as local then convert to UTC
            local_tz = dt.datetime.now().astimezone().tzinfo
            started = started.replace(tzinfo=local_tz).astimezone(dt.timezone.utc)
        except Exception:
            started = NOW   # fallback — a live process with no parseable start time
        minutes_in = max(0, int((NOW - started).total_seconds() // 60))
        crews.append({"seat": seat, "stint": stint_id, "lap": lap,
                       "started_at": started.strftime("%H:%MZ"), "minutes_in": minutes_in,
                       "bay": stint_lookup(stint_id)["bay"]})
    # deduplicate by stint — keep the newest lap (most recent lap ID: a re-drive's
    # lap id is lexicographically > day one's; prefer the higher-started_at among
    # same-lap-ID duplicates from pre-.pulse-filter days where two entries were one crew)
    deduped = {}
    for c in crews:
        sid = c["stint"]
        if sid not in deduped:
            deduped[sid] = c
        else:
            existing = deduped[sid]
            if c["lap"] > existing["lap"]:                 # newer lap wins
                deduped[sid] = c
            elif c["lap"] == existing["lap"] and c["minutes_in"] > existing["minutes_in"]:
                deduped[sid] = c                            # same lap, prefer longer-running
    return list(deduped.values())

# stint_bay: stint id → bay from stints.jsonl. Used to tag crews with their team.
_stint_bays = None
def stint_lookup(sid):
    global _stint_bays
    if _stint_bays is None:
        _stint_bays = {}
        p = os.path.join(BRAIN, "receipts/stints.jsonl")
        if os.path.exists(p):
            for line in open(p):
                try:
                    t = json.loads(line)
                    tid = t.get("id")
                    if tid is not None:
                        _stint_bays[tid] = dict(bay=t.get("bay") or "studio-b",
                                                budget=t.get("budget_min"),
                                                headline=t.get("headline") or t.get("title", ""))
                except Exception: pass
    return _stint_bays.get(sid) or dict(bay="studio-b", budget=None, headline="")

# ── flags ────────────────────────────────────────────────────────────────────
def open_flags():
    p = os.path.join(BRAIN, "flags.md")
    rows = []
    if os.path.exists(p):
        for line in open(p):
            if line.startswith("## "): break  # first table only; the legend is below the first H2
            m = re.match(r"^\| \*\*(SC|VSC|RED)\*\* \| ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\|", line)
            if m: rows.append(dict(flag=m[1], scope=m[2].strip(), thrown=m[3].strip(), by=m[4].strip(), lifter=m[6].strip()))
    jp = os.path.join(BRAIN, "flags.jsonl")
    if os.path.exists(jp):
        for line in open(jp):
            try: fl = json.loads(line)
            except Exception: continue
            scope = fl.get("key", "").split(":", 1)[-1]
            lifter = "kevin" if fl.get("flag") == "blue" else "runner"
            rows.append(dict(flag=fl["flag"], scope=scope, thrown=fl.get("ts", ""), by=fl.get("thrown_by", "lap-verdict"), lifter=lifter))
    return rows

# ── seats ────────────────────────────────────────────────────────────────────
def seat_state(seat):
    s = dict(seat=seat, lock=os.path.isdir(f"{STATE}/{seat}.lock"), last=None, status=None, rearm=None, pending=None, missed=None, hours=[], lock_started=None)
    if s["lock"]:
        try: s["lock_started"] = dt.datetime.fromtimestamp(os.stat(f"{STATE}/{seat}.lock").st_mtime, dt.timezone.utc).strftime("%H:%MZ")
        except Exception: pass
    try:
        j = json.load(open(f"{STATE}/{seat}.last-run.json")); s["last"] = j.get("started_at"); s["status"] = j.get("status")
    except Exception: pass
    try: s["rearm"] = open(f"{STATE}/{seat}.rearm-at").read().strip()
    except Exception: pass
    try:
        pl = plistlib.load(open(f"{AGENTS}/com.studiob.shift-{seat}.plist", "rb"))
        s["hours"] = sorted(h.get("Hour") for h in pl.get("StartCalendarInterval", []) if isinstance(h, dict))
    except Exception: pass
    out = sh([INBOX, "pending", seat, "200"])
    try: s["pending"] = len(json.loads(out).get("messages") or [])
    except Exception: s["pending"] = "?"
    # missed slot: the most recent scheduled local hour that has passed with no START after it
    if s["hours"]:
        local = dt.datetime.now().astimezone()
        past = [h for h in s["hours"] if h <= local.hour]
        if past:
            slot = local.replace(hour=max(past), minute=0, second=0, microsecond=0)
            last = iso(s["last"]) if s["last"] else None
            if (NOW - slot.astimezone(dt.timezone.utc)).total_seconds() > 20*60 and (not last or last < slot.astimezone(dt.timezone.utc)):
                s["missed"] = f"{max(past):02d}:00 local"
    return s

# ── race record ──────────────────────────────────────────────────────────
def load_races():
    p = os.path.join(BRAIN, "receipts/races.jsonl")
    if not os.path.exists(p): return {}
    races = {}
    for line in open(p):
        try: r = json.loads(line); races[r["id"]] = r
        except Exception: pass
    return races

def race_drift(r):
    if r.get("state") == "finished": return "🏁", ""
    tw = r.get("target_week", "")
    if tw:
        target = dt.datetime.strptime(tw + "T23:59:59Z", "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        d = (NOW - target).days
        if d > 3: return "⚪", f"LATE +{d}d"
    return "🟢", "pace"

# ── OPEN CUSTOMER P1s (Guard 6 of the HERFAB post-mortem, stint #246, 2026-09-13). A team whose
#    registered repos (the kit's `repos:`) carry an open issue labeled `zoom-intake` (or `customer`)
#    AND `P1` renders YELLOW on the glass — REGARDLESS of what colour its stints computed to.
#    Known-bad this guard fixes: Ästhetik read green all day 9/13 while client-asthetik#376/377/388
#    (zoom-intake + P1, all OPEN) sat unread — every one of its stints happened to be green/receipted
#    that day, so the team-level view never surfaced the customer-facing fire. THE TEAM'S COLOUR IS
#    NOT THE MAX OF ITS STINTS' COLOURS — a live open customer P1 is a fact the stint ledger cannot
#    see (it has no stint at all until someone files one), so it is read from GitHub directly, per
#    team, from the kit's own `repos:` list — never hand-copied, never inferred from a title grep.
P1_CACHE = os.path.join(STATE, "team-p1s.json")
def team_open_p1s():
    """team key -> {"count": N, "issues": ["<repo>#<n> <title>", ...]}. Cached 5 min (gh calls, one
    `gh issue list` per registered repo). An issue counts only with BOTH labels present: P1 AND
    (zoom-intake OR customer) — the Guard 6 predicate, verbatim from the stint title."""
    try:
        st = os.stat(P1_CACHE)
        if (dt.datetime.now().timestamp() - st.st_mtime) < 300: return json.load(open(P1_CACHE))
    except Exception: pass
    out = {}
    for team in TEAMS.values():
        hits = []
        for repo in team.get("repos") or []:
            js = sh(["gh", "issue", "list", "-R", repo, "--state", "open", "--label", "P1",
                     "--json", "number,title,labels"], timeout=20)
            try: issues = json.loads(js) if js.strip() else []
            except Exception: issues = []
            for iss in issues:
                labels = {l["name"] for l in iss.get("labels", [])}
                if "zoom-intake" in labels or "customer" in labels:
                    hits.append(f"{repo.split('/')[-1]}#{iss['number']} {iss.get('title','')[:60]}")
        out[team["key"]] = {"count": len(hits), "issues": hits}
    try: json.dump(out, open(P1_CACHE, "w"))
    except Exception: pass
    return out

# ── stints (telemetry — THE source, 2026-09-13) ──────────────────────────────
# receipts/stints.jsonl is the queue. scripts/stint.py writes it. Nothing else is read.
LAST_RCPT = None
def load_last_receipts():
    """stint id → ts of the newest seat receipt naming it (receipts/stints/*.jsonl: `stint` or `stints: [bay#id]`). Cached per run."""
    global LAST_RCPT
    if LAST_RCPT is not None: return LAST_RCPT
    out = {}
    for f in glob.glob(os.path.join(BRAIN, "receipts/stints/*.jsonl")):
        for line in open(f):
            try: r = json.loads(line)
            except Exception: continue
            for sid in ([r.get("stint")] + [int(x.split("#")[-1]) for x in (r.get("stints") or []) if str(x).split("#")[-1].isdigit()]):
                if sid is None: continue
                ts = iso(r.get("ts") or "")
                if ts and (sid not in out or ts > out[sid]): out[sid] = ts
    LAST_RCPT = out; return out

def load_stints(in_flight, crews=None):
    p = os.path.join(BRAIN, "receipts/stints.jsonl")
    if not os.path.exists(p): return []
    # Build stint_id → crew map from live launchd jobs (stint #329, 2026-09-14)
    crew_by_stint = {}
    if crews:
        for c in crews: crew_by_stint[c["stint"]] = c
    # GREEN IS A RECEIPT, NOT A STATUS (Kevin 9/13 01:5xZ: "it looks like some stints have been completed by the Ästhetik car… I haven't
    # seen anything change in Acumatica"). in_progress is a write-time claim; racing = a seat receipt naming this stint in the last 6h.
    last_rcpt = load_last_receipts()
    GRIDDED = set()
    for gf in glob.glob(os.path.join(BRAIN, 'receipts/grid/*.json')):
        try: GRIDDED |= set(json.load(open(gf)).get('stints', []))
        except Exception: pass
    stints = []; candidates = {}
    for line in open(p):
        try: t = json.loads(line)
        except Exception: continue
        # A session-shaped stint is BOTH the crew's task and the owner's calendar block. The crew marking
        # its own work done must not erase a block for a session that has not happened yet (#298).
        if t.get("status") == "done" and t.get("shape") != "session": continue
        tags = set(t.get("tags") or []); company = t.get("bay", "?"); seat = t.get("seat") or "—"
        upd = iso(t.get("updated") or ""); hrs = (NOW - upd).total_seconds()/3600 if upd else 1e9
        fire = "fire" in tags
        # ── THE THREE-STATE BOARD (Kevin 9/13 06:4xZ). A stint's colour is COMPUTED here from claim + receipts — never written to the
        #    record by the reaper, lap-verdict, decisions-apply or a person. Five writers and no owner of what a colour means is why
        #    the board lied in both directions today (green with no work at 01:5x; grey/stalled over seven finished crews at 06:2x).
        #    unclaimed (grey)  — no seat, or a seat and no contract and no receipt in this race. "Nobody has said they'll do it."
        #    claimed  (grey·)  — on a grid or under a live contract; no receipt yet. Waiting for its lap, not dormant.
        #    racing   (green)  — a live contract AND a receipt inside the lap window.
        #    receipted (green·) — a crew/seat receipt exists; not `done`; the RE has not closed it. NOT stalled — awaiting the RE's verdict.
        #    stalled  (yellow) — a contract was RELEASED as a miss (over-budget/unwritten/stranded) with NO receipt since, or a fire >6h with
        #                        no receipt, or anything >48h with no receipt. "A lap was owed and did not happen."
        #    blue              — seat == kevin or blocked: a card, not work.
        rc = last_rcpt.get(t["id"]); rc_hrs = (NOW - rc).total_seconds()/3600 if rc else None
        live = t.get("contract"); miss = t.get("last_miss") or {}
        miss_at = iso(miss.get("at") or ""); missed_since = (rc is None or (miss_at and rc < miss_at))   # a miss stands only if no receipt came after it
        gridded = t["id"] in GRIDDED
        # a crew launchd job running = the stint is actively being worked — overrides any miss (stint #329)
        ccrew = crew_by_stint.get(t["id"])
        if ccrew:
            st = f"🟢 going hard {ccrew['minutes_in']}m"
        elif seat == "kevin" or t.get("blocked"): st = "🔵 BLOCKED on Kevin"                                 # §blue — library/telemetry/predicates.md (#465, stint #295): fire/customer never independently promote to blue
        elif live and rc_hrs is not None and rc_hrs <= 6: st = "🟢 racing"
        elif rc is not None and not (miss and missed_since): st = "🟢 receipted"      # awaiting the RE's verdict — self-clears at the RE's lap
        elif miss and missed_since: st = "🟡 STALLED"
        elif fire and hrs > 6 and rc is None: st = "🟡 STALLED"
        elif hrs > 48 and rc is None: st = "🟡 STALLED"
        elif live or gridded: st = "⚪ claimed"
        elif seat in ("—", "", None): st = "⚪ unclaimed"
        else: st = "⚪ unclaimed"
        if fire: st = "🔥 " + st
        if fire and seat in in_flight: candidates.setdefault(seat, []).append(len(stints))
        # precedence (#329): a crew in flight = "going hard Nm" — the earlier miss is history under it
        title = t.get("title", "")[:72]
        headline = t.get("headline")
        if ccrew:
            headline = re.sub(r"^(FIRE\s*⚠\s*)?STALLED\s+\d+h[:—–-]\s*", "", (headline or ""))
            title = re.sub(r"^(FIRE\s*⚠\s*)?STALLED\s+\d+h[:—–-]\s*", "", title)
        stints.append(dict(id=t["id"], company=company, seat=seat, title=title, headline=headline, **{"for": t.get("for")}, shape=t.get("shape"), budget_min=t.get("budget_min"), state=st, tags=tags,
                           age=age(upd), pri=t.get("priority",""), status=t.get("status",""), comments=0,
                           artifact=t.get("artifact"), clock=t.get("clock"),
                           crew=ccrew))   # live crew launchd job joined from load_crews() (stint #329)
    for seat, idxs in candidates.items():
        declared = None
        try: declared = int(open(f"{STATE}/{seat}.racing").read().strip())
        except Exception: pass
        newest = next((i for i in idxs if stints[i]["id"] == declared), None) or max(idxs, key=lambda i: stints[i]["id"])
        for i in idxs:
            # a live crew (going hard Nm) takes precedence over the seat-lock proxy (stint #329 v2)
            if "going hard" in stints[i]["state"]: continue
            stints[i]["state"] = "🔥 🟢 racing (lap in flight)" if i == newest else stints[i]["state"].replace("⚪ queued", "⚪ queued behind the lap")
    return stints

# ── the glance (leg 2, 9/12) ─────────────────────────────────────────────────
# One JSON the HUD renders. States are the flag palette's words: green (moving) · yellow (caution) ·
# blue (on Kevin) · done · open (unlit). `meatball` = a seat's car is damaged and it is working it. No "fire". Grouped by THING (the shape, 9/12):
# today Studio b. · Ästhetik; Toto joins when its stints carry thing:toto. Cards only name a roster key.
THING_LABEL = {"studio-b": "Studio b.", "asthetik": "Ästhetik"}
ROSTER_KEY = {k: v["role"] for k, v in ROSTER.items()} | {"kevin": "you", "—": "Nobody yet"}
def hud_state(st):
    if "🔵" in st: return "blue"
    if "🟡" in st: return "yellow"
    if "🟢" in st: return "green"
    if "🏁" in st: return "done"
    return "open"

# ── cards: the race engineer's draft for a blue, written AS Kevin (the-shape §race engineer, 9/12). receipts/cards/<bay>/<id>.md.
# board.py only READS them; the RE seat writes them. No card → the glass says so, naming the RE, not the TP.
def load_card(bay, sid):
    if isinstance(sid, str) and sid.startswith("pr:"):
        repo, n = sid[3:].split("#"); p = next((x for x in load_prs() if x["repo"] == repo and str(x["n"]) == n), None)
        read = _card_from_file(os.path.join(BRAIN, "receipts", "cards", bay, f"pr-{repo}-{n}.md"))   # THE READ (#296): written from the diff + the door's flags
        # 9/16 06:2xZ (the card guard's first re-admission): the door's "still refuses … key it?" template below used to win
        # over a WRITTEN read, so client-asthetik#384 and studiob-price-sync#195 — reviewed, refused at a leg, carrying the
        # Principal's operator card — were pulled back for the template's own developer title. A read, once written, is the card.
        if read: return read
        if p and still_refused(p["labels"]) and door_leg(p["full"], p["n"]) != "review":
            leg = door_leg(p["full"], p["n"]); url = p.get("url") or f"https://github.com/studio-b-ai/{repo}/pull/{n}"
            care = " Careful: named-checks means a required check is missing or red — box merges past it." if leg == "named-checks" else ""
            return {"verdict": "act", "gate_until": "", "decided": "", "deferred": "", "by": "the release door", "written": "", "verified_at": NOW.strftime("%H:%MZ"),
                    "_door_template": True,
                    "decision": f"This PR carries reviewed (the retired key); the door still refuses {repo}#{n} at its {leg} leg. Box it?",
                    "rec": f"**Box it: the label box, one click at {url}** — box is the one key; it opens every decision leg, {leg} included (CI and sensitive paths stay the floor).{care}" + (f" The read said: {(read.get('rec') or '')[:220]}" if read else ""),
                    "default": "It stays open with reviewed; nothing merges on silence.",
                    "why": "One key merges it and you hold it (2026-09-15-box-is-the-one-key.md). This row predates the rename — its reviewed was the old glass's accept; the glass now applies box, so this label is your click.",
                    "how": f"gh pr view {n} -R studio-b-ai/{repo} → labels needs-human, reviewed, no box · the door's last flag comment: leg={leg} · {url}"}
        if read: return read
        if p and "needs-human" in p["labels"]: return None   # door FLAG, no read yet = UNDRAFTED (§8a/§8b): the flag rides the row's `for`; no keys until a reader has read the diff
        labels = ", ".join(p["labels"]) if p and p["labels"] else "none"
        return {"verdict": "act", "gate_until": "", "decided": "", "deferred": "", "by": "the release door", "written": "", "verified_at": NOW.strftime("%H:%MZ"),
                "_door_template": True,
                "decision": "Box this pull request for the release door?",
                "rec": "**Box it.** CI is green and it carries no label — the door merges only what carries `box`. Accept applies the label; the next sweep merges once the Sonnet vote is CLEAN.",
                "default": "It waits. Nothing merges without a label.",
                "why": "The door's authority list is you (label-authority.ts): a human PR with no label is yours to queue or hold.",
                "how": f"gh pr list across the fleet registry · checks rollup all SUCCESS/SKIPPED · labels: {labels} · cached ≤5 min."}
    return _card_from_file(os.path.join(BRAIN, "receipts", "cards", bay, f"{sid}.md"))

def _card_from_file(f):
    if not os.path.exists(f): return None
    txt = open(f, encoding="utf-8").read()
    fm = {}
    m = re.match(r"^---\n(.*?)\n---\n", txt, re.S)
    if m:
        for ln in m.group(1).splitlines():
            if ":" in ln: k, v = ln.split(":", 1); fm[k.strip()] = v.strip()
        txt = txt[m.end():]
    # delegate validation to the one source of truth (#330): card-lint.py
    ok, reason = lint_card(f, silent=True)
    if not ok:
        author = fm.get("by", "unknown")
        return {"malformed": True, "verdict": "malformed", "by": author, "written": fm.get("written", ""),
                "reason": reason, "missing": [reason] if reason else []}

    # card passed lint — parse sections from already-stripped text and compute verdict

    # stint #413: support both legacy (Decision · Rec · Default on silence · Why it's yours · Live-verified how)
    # and new (Situation · Purpose · End state) section names.
    secs = {}
    for name, body in re.findall(r"^## (.+?)\n(.*?)(?=^## |\Z)", txt, re.S | re.M): secs[name.strip()] = body.strip()

    # Map new section names to their legacy equivalents for backward compatibility in the card dict
    if all(k in secs for k in ("Situation", "Purpose", "End state")):
        decision = secs["Situation"]; rec = secs["Purpose"]; default = secs["End state"]
        why = ""; how = ""
        # extract the ask line (one link in the end state or a trailing paragraph)
        ask_match = re.search(r'\[([^\]]+)\]\((https?://[^)]+)\)', secs.get("End state", "") + "\n" + secs.get("Situation", "") + "\n" + secs.get("Purpose", ""))
        if ask_match: how = f"{ask_match.group(1)}: {ask_match.group(2)}"
        if secs.get("The ask"): how = secs["The ask"]   # the ask line, verbatim, with its link (#487) — first firing 9/16
    else:
        decision = secs.get("Decision", ""); rec = secs.get("Rec", ""); default = secs.get("Default on silence", "")
        why = secs.get("Why it's yours", ""); how = secs.get("Live-verified how", "")
    rec_stripped = re.sub(r"[*_`]", "", rec).strip()
    rec0 = rec_stripped.lower()
    verdict = "gate" if re.match(r"(not yet|wait|gated|after )", rec0) else ("strike" if rec0.startswith("strike") else "act")
    gate_until = fm.get("gate_until", "")
    return {"verdict": verdict, "gate_until": gate_until, "decided": fm.get("decided", ""), "deferred": fm.get("deferred", ""),
            "decision": decision, "rec": rec, "default": default,
            "why": why, "how": how,
            "title": fm.get("title", ""),   # the operator's title (2026-09-16-cards-speak-to-the-operator.md); the row's headline when present
            "by": fm.get("by", "race-engineer"), "written": fm.get("written", ""), "verified_at": fm.get("verified_at", "")}


# ── PRs ON THE BOARD (Kevin 9/13 05:5xZ: "I don't think I've seen a blue flag for a merge today… I've seen them here in this session").
#    A green fleet-internal PR with no ready/`fleet-internal` label was invisible: in a receipt's `prs`, never on the glass. Now every
#    open PR the fleet authored is read from GitHub (cached 5 min), classified, and either rides the door (labeled → no card) or
#    becomes a CARD for Kevin: "cp#272 green 2h — queue it?" Accept applies `box` through the door's API. His click, as a card.
PR_CACHE = os.path.join(STATE, "prs.json")
def load_prs():
    # 9/15 02:3xZ (Kevin keyed radio#1008 AND radio#1008 tonight — one PR): the fleet registry names a renamed repo under both
    # names (studio-b-ai/radio → radio; GitHub redirects the old name), so every radio PR rendered as two cards, was read twice
    # by the RE and evaluated twice by the door. A PR belongs to the repo in its own URL; a row whose registry name is not in its URL is
    # the same PR under a stale name — dropped on EVERY return path (cache or fresh) so the glass shows one card per PR whatever the
    # registry says. Control: gh's redirect makes radio#1008's url .../radio/pull/1008.
    return [p for p in (_load_prs_raw() or []) if f"/{p.get('repo','')}/pull/" in (p.get("url") or "")]

def _load_prs_raw():
    try:
        st = os.stat(PR_CACHE)
        if (dt.datetime.now().timestamp() - st.st_mtime) < 300: return json.load(open(PR_CACHE))
    except Exception: pass
    out = []
    try:
        reg = subprocess.run(["gh", "api", "repos/studio-b-ai/ops-pipeline/contents/scripts/squasher-fleet.json", "-q", ".content"], capture_output=True, text=True, timeout=20).stdout
        import base64; d = json.loads(base64.b64decode(reg)); repos = d.get("repos", d); repos = repos if isinstance(repos, list) else list(repos.keys())
        repos = [r if isinstance(r, str) else r.get("repo", "") for r in repos]
        for repo in repos:
            # 9/15 04:1xZ debug D2G-3: a window of 40 hid door flags in brain (57 open) and client-asthetik (51) from every instrument; 200 covers each fleet repo today — the label-directed union is stint #360
            js = subprocess.run(["gh", "pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", "number,title,labels,statusCheckRollup,createdAt,url,author,mergeable"], capture_output=True, text=True, timeout=30).stdout
            for pr in (json.loads(js) if js.strip() else []):
                labels = [l["name"] for l in pr.get("labels", [])]
                concl = {c.get("conclusion") or c.get("state") or "PENDING" for c in pr.get("statusCheckRollup", [])}
                green = bool(concl) and concl <= {"SUCCESS", "SKIPPED", "NEUTRAL"}
                red = bool(concl & {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"})
                out.append({"repo": repo.split("/")[-1], "full": repo, "n": pr["number"], "title": pr["title"], "url": pr["url"], "labels": labels,
                            "green": green, "red": red, "pending": not green and not red, "created": pr["createdAt"],
                            "author": (pr.get("author") or {}).get("login", ""), "mergeable": pr.get("mergeable")})
        for p in out:   # 9/14: the door's own words ride the PR — a FLAG card must show what the door said, not a template
            if "needs-human" in p["labels"]:
                try:
                    body = subprocess.run(["gh", "api", f"repos/{p['full']}/issues/{p['n']}/comments", "--jq", '[.[]|select(.user.login=="studiob-fleet-bot[bot]")|.body]|last'], capture_output=True, text=True, timeout=20).stdout
                except Exception: body = ""
                mv = re.search(r"votes: ([^\n—]+)", body)
                bullets = [re.sub(r"\s+", " ", l.strip()[2:]).strip()[:170] for l in body.splitlines() if l.strip().startswith("- ")][:3]
                if not bullets: bullets = [re.sub(r"\s+", " ", l.strip())[:170] for l in body.splitlines() if l.strip() and not l.strip().startswith(("**", "_", "votes", "<!--"))][:2]
                p["door"] = {"votes": (mv.group(1).strip() if mv else "FLAG"), "bullets": bullets}
                json.dump(out, open(PR_CACHE, "w"))
    except Exception as e:
        print(f"[board] load_prs failed: {e!r} — serving the cached list", file=sys.stderr)   # 9/14: a swallowed exception hid an empty board for hours
        try: return json.load(open(PR_CACHE))
        except Exception: return []
    return out
_LEG = {}
def door_leg(full, n):
    """the leg named in the door's last flag comment (<!-- gate-flag <leg> <sha> -->): class-match · line-cap · named-checks · review · unknown"""
    k = f"{full}#{n}"
    if k in _LEG: return _LEG[k]
    try:
        out = subprocess.run(["gh", "pr", "view", str(n), "-R", full, "--json", "comments", "--jq",
                              '[.comments[].body|capture("<!-- gate-flag (?<leg>[a-z-]+) ")?.leg]|map(select(.!=null))|last // ""'],
                             capture_output=True, text=True, timeout=20).stdout.strip().strip('"')
    except Exception: out = ""
    _LEG[k] = out or "unknown"; return _LEG[k]
def still_refused(labels):
    """9/15 02:4xZ (Kevin: "I don't see any blue flags on toto"): his accept applied `reviewed`, the door still refused, and the row
    vanished from his queue as if done. reviewed opens only the review leg; a PR refused at class-match / line-cap / named-checks is
    his again with the one key that opens it (`box` since the 2026-09-15 rename — `queued` reads as the transition-week alias;
    2026-09-15-box-is-the-one-key.md). A PR carrying EITHER ready spelling is keyed, never still-refused."""
    L = set(labels or []); return "needs-human" in L and "reviewed" in L and "box" not in L and "queued" not in L and "hold" not in L
def pr_cards():
    """open PRs → glance rows. rides = labeled (door will merge) · asks = carded (Kevin's queue) · flags = door flags the RE must read before they reach Kevin · red = CI failing (Technical's)"""
    prs = load_prs(); rides, asks, red, flags = [], [], [], []
    for p in prs:
        L = set(p["labels"]); age = age(p["created"]) if False else None
        if "hold" in L: continue
        # DIRTY (conflicting) PRs never card — they go back to the crew (stint #410)
        if p.get("mergeable") == "CONFLICTING": continue
        # 9/13 door pens: the release door's review FLAG lands as `needs-human` — a blue card. Kevin's `a` → `box` (the one key,
        # 2026-09-15; `reviewed` was the pre-rename receipt, `queued` the old spelling) and the next sweep merges; `x` → `hold`.
        # Checked BEFORE rides: a flagged fleet-internal PR is NOT riding. A flag carrying ANY answer spelling (box · queued ·
        # reviewed) is keyed/answered — never an unanswered ask.
        # stint #410: a door flag is born on the RE's row; it moves to Kevin's queue only when the RE writes a card file.
        if "needs-human" in L and "reviewed" not in L and "box" not in L and "queued" not in L:
            p["flag"] = "review"
            bay = "studio-b" if p["repo"] in ("claude-config-plane","ops-pipeline","brain","power-unit","toto","lightsout","radio") else "asthetik"
            card_fn = f"pr-{p['repo']}-{p['n']}.md"
            card_path = os.path.join(BRAIN, "receipts", "cards", bay, card_fn)
            if os.path.exists(card_path):
                asks.append(p)   # the RE has read it → Kevin's queue
            else:
                flags.append(p)   # the RE hasn't read it yet → RE's row, not Kevin's
            continue
        if still_refused(L):
            leg = door_leg(p["full"], p["n"]); p["leg"] = leg
            if leg == "review": rides.append(p); continue     # reviewed IS the key for the review leg: the next sweep merges it
            p["flag"] = "refused"; asks.append(p); continue   # class-match · line-cap · named-checks · unknown: still Kevin's, with the key named
        if p["green"] and ("box" in L or "queued" in L or "fleet-internal" in L or ("bugsquasher" in L and "candidate" in L)): rides.append(p)   # box = the one key (2026-09-15); queued = its transition-week alias
        elif p["green"] and p.get("author") in ("kbibelhausen",) and not L: asks.append(p)   # 9/14 02:3xZ: only an UNLABELED human PR is Kevin's; seat PRs are labeled at box and ride the door (ops#417). 31 door PRs were rendering as cards.
        elif p["red"]: red.append(p)
    return {"rides": rides, "asks": asks, "red": red, "flags": flags, "pending": [p for p in prs if p["pending"]]}

def glass_title(t):
    """The glass never says FIRE / a seat key / 'Kevin:' / 'Technical:' — the flag and the roster word carry those. Strip the board's
    leading prefixes (repeatedly: `FIRE — Technical (leg 1): …`), then end at the first ' — ' or ' · ' so a row reads like a headline."""
    t = t.strip()
    t = re.sub(r"^FIRE\s*⚠\s*STALLED \d+h:\s*", "", t)
    t = re.sub(r"^LOCKED [^—]*—\s*", "", t)
    PREFIX = re.compile(r"^(⚠\s*)?(FIRE|race|onboard|TP|Technical|Kevin|Growth|OS|Mechanic|Engineer|Controller|Financial|Commercial|Product Record|P\d|STALLED \d+h|mechanic|engineer|controller|financial-sb|commercial)\b\s*(\([^)]*\))?\s*[—:·+-]+\s*", re.I)
    for _ in range(4):
        m = PREFIX.match(t)
        if not m: break
        t = t[m.end():]
    t = re.split(r" — | · |\s+\((?=you are|default|after|comment|studiob#)", t, 1)[0].strip(" -—·:")
    return (t[:1].upper() + t[1:]) if t else t

def last_decision_ts():
    """The clock for `since`: the ts of Kevin's newest word on a card (receipts/decisions.jsonl, written by Toto's
    `decide`). The sent folder is the clock — not the wall clock, not the session (DESIGN.md §the node · Since)."""
    p = os.path.join(BRAIN, "receipts/decisions.jsonl")
    last = None
    if os.path.exists(p):
        for line in open(p):
            try: ts = iso(json.loads(line).get("ts") or "")
            except Exception: continue
            if ts and (last is None or ts > last): last = ts
    return last

def since_block(stints, races):
    """`since` — what moved since Kevin's last decision: done (receipted/complete this window) · new (stints filed
    this window) · merged (PRs merged this window). Toto's Since panel renders it; stint #231 publishes it.
    Anchored on last_decision_ts(); with no decision on record the window is the last 6h (Rule #332: the baseline
    is named before the delta)."""
    anchor = last_decision_ts() or (NOW - dt.timedelta(hours=6))
    rcpts = load_last_receipts()
    done, new, merged, items = [], [], [], []
    for s in stints:
        sid = s["id"]; created = iso(s.get("created") or "")
        rc = rcpts.get(sid)
        if rc and rc > anchor:
            done.append(sid)
            items.append({"kind": "done", "id": sid, "t": (s.get("headline") or glass_title(s["title"]))[:56],
                          "for": s.get("for"), "at": rc.strftime("%H:%MZ"), "team": s.get("company")})
        elif created and created > anchor:
            new.append(sid)
            items.append({"kind": "new", "id": sid, "t": (s.get("headline") or glass_title(s["title"]))[:56],
                          "for": s.get("for"), "at": created.strftime("%H:%MZ"), "team": s.get("company")})
    for p in (pr_cards().get("merged") or []):
        m = iso(p.get("mergedAt") or p.get("merged_at") or "")
        if m and m > anchor:
            merged.append(f"{p['repo']}#{p['n']}")
            items.append({"kind": "merged", "id": f"{p['repo']}#{p['n']}", "t": p.get("title", "")[:56],
                          "at": m.strftime("%H:%MZ"), "team": "studio-b"})
    items.sort(key=lambda i: i.get("at") or "", reverse=True)
    return {"anchor": anchor.strftime("%Y-%m-%dT%H:%M:%SZ"), "anchored_on": "last decision" if last_decision_ts() else "last 6h",
            "done": done, "new": new, "merged": merged, "items": items[:12]}

def race_done_pct(r, stints):
    """done_pct for one race: the share of its stint_ids that are no longer open work. The gantry's five lamps read
    it directly (DESIGN.md §4: a lamp goes out as each fifth of the race closes)."""
    ids = r.get("stint_ids") or []
    if not ids: return 0
    open_ids = {s["id"] for s in stints}
    closed = sum(1 for i in ids if i not in open_ids)
    return int(round(100 * closed / len(ids)))

def session_rows(all_stints):
    """THE DESK (9/14, the-session-shape-owner-judgement-in-the-file.md §Acceptance): sessions are published APART from queue[].
    A session is owner judgement over an ARTIFACT on the owner's clock — never a card, so it never enters the deck and carries no
    keys (§8a: keys belong to cards). Two honest facts per row:
      prep.ready — the fleet has LAID IT OUT: the artifact is a real path (not a seat's placeholder) AND the prepping seat has filed
                   a receipt naming the stint. Both are records, never a promise (#355/#376: a claim of ready needs its receipt).
      clock      — the target day the RE books it on; `when` is the plain-words line the mirror renders.
    Sessions are read BEFORE the race filter: the owner's desk is not a race, so a session on ast-t1 still books on Kevin's Today."""
    rcpts = load_last_receipts()
    out = []
    for s in all_stints:
        # session_rows computes prep.ready itself from artifact+receipt, so the crew-task status field
        # is not its business at all.
        if s.get("shape") != "session": continue
        art = (s.get("artifact") or "").strip()
        placeholder = (not art) or art.startswith("(") or "sets:" in art          # a seat's TODO in the field is not an artifact
        rc = rcpts.get(s["id"])
        why = ("no artifact yet — the prepping seat has not named the file" if placeholder
               else ("no prep receipt yet — the seat has not laid the file out" if not rc else None))
        out.append({"id": s["id"], "bay": s.get("company") or s.get("bay"), "seat": s["seat"],
                    "headline": s.get("headline") or glass_title(s.get("title") or "")[:56],
                    "for": s.get("for"), "artifact": None if placeholder else art, "clock": s.get("clock"),
                    "kind": "session", "shape": "session",     # the glass asserts BOTH: a desk block, never a deck card
                    "prep": {"ready": not (placeholder or not rc), "why": why},
                    "who": ROSTER_KEY.get(s["seat"], s["seat"]), "age": s.get("age")})
    out.sort(key=lambda r: (r["clock"] or "9999-99-99", r["id"]))
    return out

def radio_thread():
    """Last 30 kevin↔team-principal rail messages, newest-first. Reads the seat-inbox
    HTTP API directly (same bearer auth as ~/.claude/bin/seat-inbox) without acking."""
    env_file = os.path.expanduser("~/.claude/state/seat-inbox.env")
    if not os.path.exists(env_file):
        return []
    url = token = None
    for line in open(env_file):
        line = line.strip()
        if line.startswith("SEAT_INBOX_URL="):
            url = line.split("=", 1)[1].strip()
        elif line.startswith("SEAT_INBOX_TOKEN="):
            token = line.split("=", 1)[1].strip()
    if not url or not token:
        return []
    import urllib.request as _ur
    msgs = []
    for to_seat in ("team-principal", "kevin"):
        try:
            req = _ur.Request(
                f"{url}/internal/seat-inbox/unacked?to_seat={to_seat}&limit=100",
                headers={"Authorization": f"Bearer {token}"},
                method="GET",
            )
            with _ur.urlopen(req, timeout=10) as resp:
                body = json.loads(resp.read())
            for m in body.get("messages") or []:
                m["_to"] = to_seat
                msgs.append(m)
        except Exception:
            pass
    out = []
    seen = set()
    for m in sorted(msgs, key=lambda m: m.get("created_at", ""), reverse=True):
        kid = m.get("id")
        if kid and kid not in seen:
            seen.add(kid)
            from_s = m.get("from_seat", "")
            to_s = m.get("_to", "")
            if from_s == "kevin" and to_s == "team-principal":
                out.append(m)
            elif from_s == "team-principal" and to_s == "kevin":
                out.append(m)
        if len(out) >= 30:
            break
    for m in out:
        m.pop("_to", None)
    return out

def glance_json(stints, kevin_rows, flags, seats, races, sessions=(), crews=()):
    # ── enriched crews: raw launchd jobs joined to stints.jsonl for bay + budget (stint #329)
    stint_map = {s["id"]: s for s in stints}
    glance_crews = []
    for c in crews:
        s = stint_map.get(c["stint"], {})
        glance_crews.append({"stint": c["stint"], "seat": c["seat"], "lap": c["lap"],
                             "minutes_in": c["minutes_in"], "started_at": c["started_at"],
                             "budget": s.get("budget_min") or stint_lookup(c["stint"])["budget"],
                             "bay": s.get("company") or stint_lookup(c["stint"])["bay"],
                             "headline": s.get("headline") or stint_lookup(c["stint"])["headline"] or (s.get("title", "")[:56])})
    n_crews = len(glance_crews)
    things = {}
    for s in stints:
        th = things.setdefault(s["company"], {"key": s["company"], "label": THING_LABEL.get(s["company"], s["company"]), "stints": []})
        who = ROSTER_KEY.get(s["seat"], s["seat"])
        fire = s["state"].startswith("🔥")
        # VOCABULARY (Kevin 9/12 6:1xpm): "fire" is a cause, not a state — the glass shows a FLAG. A `fire`-tagged
        # stint is either MEATBALL (a seat has it: the car is damaged, the seat is working it) or BLUE (no seat, or
        # on Kevin: yield). The word "fire" never renders; the tag is data the reader translates.
        meatball = fire and who not in ("Nobody yet", "you")
        st = hud_state(s["state"])
        if fire and not meatball: st = "blue"
        desc = s["state"].replace("🔥 ","").split(" ",1)[-1].replace("BLOCKED on Kevin", "on you")
        rc = load_last_receipts().get(s["id"]); rc_age = age(rc) if rc else None
        th["stints"].append({"id": s["id"], "t": (s.get("headline") or glass_title(s["title"]))[:56], "headline": s.get("headline"), "for": s.get("for"), "shape": s.get("shape"), "budget": s.get("budget_min"), "s": st, "meatball": meatball,
                             "d": " · ".join(x for x in (who, desc, s["age"]) if x), "who": who, "race": s.get("race"),
                             "sub": s["state"].replace("🔥 ","").split(" ",1)[-1].split(" ")[0].lower(),   # racing · receipted · claimed · unclaimed · stalled · blocked
                             "seat": s["seat"], "team": s["company"], "crew": bool(s.get("crew")),
                             "receipt": rc_age, "desc": desc, "age": s["age"]})
    PRS = pr_cards()
    for p in PRS["asks"]:
        hrs = (NOW - iso(p["created"])).total_seconds()/3600 if iso(p["created"]) else 0
        kevin_rows.append({"id": f"pr:{p['repo']}#{p['n']}", "title": f"{p['title'][:64]} ({p['repo']}#{p['n']})", "seat": "kevin", "tags": ["pr", "race:t1"], "pri": "high" if hrs > 24 else "medium",
                           "headline": (f"The door still refuses {p['repo']}#{p['n']} after your accept — key it?" if p.get("flag") == "refused" else (f"The door flagged {p['repo']}#{p['n']} — merge it anyway?" if p.get("door") else f"Queue {p['repo']}#{p['n']} for the door?")),
                           "for": (f"reviewed is on; the door's {p.get('leg','?')} leg still refuses it; box is the key" if p.get("flag") == "refused" else ((f"door {p['door']['votes']}: " + (p['door']['bullets'][0] if p['door']['bullets'] else "see the PR"))[:180] if p.get("door") else p["title"][:70])),
                           "age": age(p["created"]), "bay": "studio-b" if p["repo"] in ("claude-config-plane","ops-pipeline","brain","power-unit","toto","lightsout","radio") else "asthetik", "company": None,   # brain renamed to power-unit (2026-09-15); keep both while the registry alias flips (ops-pipeline#472)
                           "_pr": p, "state": "🔵 BLOCKED on Kevin", "status": "open", "created": p["created"], "updated": p["created"], "priority": "medium"})
    # stint #410: door flags ride the RE's row (class read), not Kevin's queue. Only a card file moves them to Kevin.
    needs_card = []
    for p in PRS["flags"]:
        bay = "studio-b" if p["repo"] in ("claude-config-plane","ops-pipeline","brain","power-unit","toto","lightsout","radio") else "asthetik"
        re_seat = (TEAMS.get(bay) or {}).get("race_engineer") or f"race-engineer-{bay}"
        door_info = p.get("door") or {}
        bullets = " · ".join((door_info.get("bullets") or [p["title"][:70]])[:2])
        reason = f"Door {door_info.get('votes', 'FLAG')}: {bullets}"
        needs_card.append({"id": f"pr:{p['repo']}#{p['n']}", "title": f"{p['repo']}#{p['n']} — door flag · RE read",
                           "by": re_seat, "reason": reason, "bay": bay, "re_class": "read"})
    def qrank(s):
        # actionable cards first · then gated (waiting on a clock) · then undrafted (the RE's stall) · then race · priority
        bay = s.get("bay") or s.get("company"); c = load_card(bay, s["id"])
        tier = 0 if (c and c.get("verdict") not in ("gate", "malformed")) else (1 if c else 2)
        # the id is the LAST tiebreak and it is MIXED-TYPE: a stint row's id is an int, a PR ask's is "pr:<repo>#<n>"
        # (appended just above). Sorting on it raw raises TypeError: '<' not supported between 'str' and 'int' the moment
        # ONE unlabeled human PR exists — which froze the live glance at 05:03:34Z on 9/14 (brain#267, then toto#9),
        # took sessions[] down with the whole payload, and made the tick log "FAIL — kept last glance" 16 of 18 runs
        # until the fix reached main (recovered 05:25:43Z). The zfill is load-bearing, not cosmetic: a bare str() also
        # stops the crash but orders lexicographically (1000 before 19), trading a loud outage for silently wrong cards.
        return (tier, not any(t.startswith("race:") for t in s["tags"]), s["pri"] != "high", isinstance(s["id"], str), str(s["id"]).zfill(8))   # 9/14: ids are ints (stints) AND strings (pr:) — never compare across
    # a blue whose card carries Kevin's word (decided:) is no longer his — it is the RE's to execute + close; keep it off the queue
    kevin_rows = [s for s in kevin_rows if not ((load_card(s.get("bay") or s.get("company"), s["id"]) or {}).get("decided"))]
    # 9/14 02:4xZ (Kevin: "22 blue flags… audit"): a STANDING idea of Kevin's own (class standing) is gated, never blue; it waits for him, he does not wait on it.
    kevin_rows = [s for s in kevin_rows if s.get("klass") != "standing" and "standing" not in (s.get("tags") or [])]
    # THE DECK EXCLUDES THE DESK (§Acceptance known-bad: "a session must NEVER appear in the card deck"). A session is the owner's
    # own sitting, not a thing to accept — it books in the Today mirror. Enforced here, at the one place queue[] is built.
    kevin_rows = [s for s in kevin_rows if s.get("shape") != "session"]
    queue = []
    for s in sorted(kevin_rows, key=qrank):
        card = load_card(s.get("bay") or s.get("company"), s["id"])
        if card and card.get("malformed"):
            draft = {"malformed": True, "by": card.get("by", "unknown"), "reason": card.get("reason", "")}
        elif card and card.get("_door_template"):
            draft = None   # stint #410: the door's own text is never a card — renders as undrafted
        elif card:
            # stint #413 card guard: validate the card speaks to the operator before it reaches Kevin
            bay = s.get("bay") or s.get("company"); sid = s["id"]
            # first firing (9/16 05:4xZ): a PR row's id is `pr:<repo>#<n>` but its card file is `pr-<repo>-<n>.md` — the
            # guard looked for `pr:claude-config-plane#379.md`, never found it, rebuilt the card from the legacy keys and
            # refused EVERY PR card as "missing Situation, Purpose, End state". Same name load_card() reads.
            card_fn = f"pr-{sid[3:].replace('#', '-')}.md" if isinstance(sid, str) and sid.startswith("pr:") else f"{sid}.md"
            card_path = os.path.join(BRAIN, "receipts", "cards", bay, card_fn)
            if os.path.exists(card_path):
                card_text = open(card_path, encoding="utf-8").read()
            else:
                # auto-generated card (PR flags): reconstruct text from the card object fields
                parts = []
                for hdr in ("Decision", "Rec", "Default on silence", "Why it's yours", "Live-verified how"):
                    val = (card.get(hdr) or card.get(hdr.lower(), ""))
                    if val: parts.append(f"## {hdr}\n{val}")
                card_text = "\n\n".join(parts)
            # the title the operator sees is the CARD's (`title:` in its frontmatter) — the board's own PR headline
            # ("The door flagged claude-config-plane#379 — merge it anyway?") is the retired shape and never passes
            title_s = card.get("title") or s.get("headline") or glass_title(s.get("title", ""))
            ok, reason = card_ok(card_text, title=title_s)
            if not ok:
                author = card.get("by", "race-engineer")
                needs_card.append({"id": s["id"], "title": title_s[:80], "by": author, "reason": reason, "bay": bay})
                continue   # never reaches Kevin's queue — renders on the author's row
            draft = {"ok": True, "verdict": card.get("verdict", "act")}
        else:
            draft = None
        queue.append({"id": s["id"], "q": glass_title(s["title"])[:120], "headline": (card or {}).get("title") or s.get("headline"), "for": s.get("for"),
                       "to": "you", "age": s["age"], "kind": "blue",
                       "standing": not any(t.startswith("race:") for t in s["tags"]),
                       "bay": s.get("bay") or s.get("company"), "card": card if not (card and card.get("_door_template")) else None, "draft": draft,
                       "re": (TEAMS.get(s.get("bay") or s.get("company") or "", {}).get("race_engineer") or "race-engineer")})
    n_act = sum(1 for q in queue if q["card"] and q["card"].get("verdict") not in ("gate", "malformed"))
    n_gate = sum(1 for q in queue if q["card"] and q["card"].get("verdict") == "gate")
    n_malformed = sum(1 for q in queue if q["card"] and q["card"].get("malformed"))
    n_undrafted = sum(1 for q in queue if not q["card"])
    calls = {}
    cp = os.path.join(BRAIN, "receipts/calls.jsonl")
    if os.path.exists(cp):
        for l in open(cp):
            try: c = json.loads(l)
            except Exception: continue
            sc = c.get("scope") or {}; key = f"team:{sc['team']}" if sc.get("team") else (f"race:{sc['race']}" if sc.get("race") else "board")
            calls[key] = None if c.get("call") == "clear" else {"call": c["call"], "ts": c["ts"], "by": c.get("by")}
    calls = {k: v for k, v in calls.items() if v}
    # the lamp counts the desk APART from blue (§Acceptance: hover says "1 desk session · prep ready/not ready")
    n_sessions = len(sessions); n_sess_ready = sum(1 for s in sessions if s["prep"]["ready"])
    panel = {"act": n_act, "gate": n_gate, "malformed": n_malformed, "undrafted": n_undrafted,
             "sessions": n_sessions, "sessions_ready": n_sess_ready,
             "crews_racing": n_crews,
             "needs_card": needs_card,   # stint #413: cards pulled from the queue — the author's row renders them
             "needs_card_count": len(needs_card),
             "blue": sum(1 for th in things.values() for x in th["stints"] if x["s"] == "blue") + len(queue),
             "meatball": sum(1 for th in things.values() for x in th["stints"] if x["meatball"]),
             "green": sum(1 for th in things.values() for x in th["stints"] if x["s"] == "green"),
             "yellow": sum(1 for th in things.values() for x in th["stints"] if x["s"] == "yellow")}
    lights = [{"flag": f["flag"], "scope": f["scope"].split(" (")[0], "lifter": ROSTER_KEY.get(f["lifter"], f["lifter"])} for f in flags]
    # GUARD 6 (stint #246): fold the open-customer-P1 read into each team's glance card. A team's
    # `things[key]` renders yellow with a count the moment ITS OWN repos carry an open zoom-intake/
    # customer + P1 issue — this is independent of (and can override) whatever colour its stints
    # computed to, because the ledger has no stint for a bug nobody has filed one for yet.
    p1s = team_open_p1s()
    for th in things.values():
        rec = p1s.get(th["key"]) or {"count": 0, "issues": []}
        th["customer_p1_open"] = rec["count"]; th["customer_p1_issues"] = rec["issues"]
        if rec["count"] > 0: th["state_override"] = "yellow"   # the glass reads this before any stint-derived colour
    panel["customer_p1"] = sum(v["count"] for v in p1s.values())
    # YELLOW IS PER SECTOR (Kevin 9/12 6:2xpm): a seat, never a stint. single = late (one missed slot, or held stints past
    # the lap cadence with no receipt); double = stopped (two consecutive slots missed, or the runner's verdict said
    # unwritten/stranded/fatal). Yellow carries WHAT THE RUNNER DOES NEXT, never an ask — an ask is blue.
    seat_rows = []
    for k, v in seats.items():
        last = iso(v["last"]) if v["last"] else None
        hrs_since = (NOW - last).total_seconds()/3600 if last else 1e9
        slots = v["hours"]
        two_missed = bool(slots) and len([h for h in slots if h <= dt.datetime.now().astimezone().hour]) >= 2 and hrs_since > 2*max(1, 24//max(1,len(slots)))
        stopped = v["status"] in ("unwritten", "stranded", "fatal", "auth", "never-ran", "timeout") or two_missed
        late = bool(v["missed"]) or (slots and hrs_since > 24//max(1,len(slots)) + 1)
        yellow = "double" if stopped else ("single" if late else None)
        nxt = None
        if yellow and v["lock"]:
            # a lap in flight under a yellow = the system is already reacting; the most important line on the glass
            started = v.get("lock_started")
            nxt = f"re-driving now · started {started}" if started else "re-driving now"
        elif yellow:
            # slots are UTC in the plist (StartCalendarInterval Hour is local — convert) — compare in local, print Z
            lh = dt.datetime.now().astimezone().hour
            upcoming = [h for h in slots if h > lh] or (slots[:1] if slots else [])
            if upcoming:
                nxt_local = dt.datetime.now().astimezone().replace(hour=upcoming[0], minute=0, second=0, microsecond=0)
                if upcoming[0] <= lh: nxt_local += dt.timedelta(days=1)
                nxt_slot = nxt_local.astimezone(dt.timezone.utc).strftime("%H:%MZ")
            else: nxt_slot = "no slot"
            nxt = (f"runner re-drives {nxt_slot}" if yellow == "double" else f"lifts on next receipt · {nxt_slot}")
        seat_rows.append({"seat": k, "who": ROSTER_KEY.get(k, k), "racing": v["lock"], "last": age(v["last"]) if v["last"] else "never",
                                  "status": v["status"], "missed": v["missed"], "pending": v["pending"],
                                  "yellow": yellow, "since": (v["last"] or "")[11:16] + "Z" if v["last"] else None,
                                  "on_demand": ROSTER.get(k, {}).get("on_demand", False),
                                  "next": nxt or ("on demand" if (ROSTER.get(k, {}).get("on_demand") or not v["hours"]) else None),
                                  "hours": v["hours"], "hours_empty": not v["hours"]})   # stint #329: the glass (and Toto) need the raw hours to decide what to show
    # stint rows under a yellow sector go still — the reader marks them so the glass drops glow/motion (rendering is the glass's)
    ysectors = {r["seat"] for r in seat_rows if r["yellow"]}
    for th in things.values():
        for x in th["stints"]:
            seat = next((s["seat"] for s in stints if s["id"] == x["id"]), None)
            x["still"] = seat in ysectors
            x["stalled"] = x["s"] == "yellow" or "STALLED" in x.get("desc", "")   # the FACT survives; the colour is the sector's
            if x["s"] == "yellow": x["s"] = "green" if x["still"] else "open"   # a stint is never yellow; its sector is
    panel["yellow"] = sum(1 for r in seat_rows if r["yellow"])
    # BY SEAT (Kevin 9/13 10:5xpm: "grouped by responsible agent … rather than how One does it by [process]"): the pivot that
    # answers "who's stalled" across teams. A lead is one crew serving N teams; crew-* dirs are not groups, they are the seat's
    # garage working a stint (crew badge). Order: seats with a double yellow first, then single, then racing, then quiet.
    ROLE = {k: v["role"] for k, v in ROSTER.items()} | {"kevin": "You"}
    srow = {r["seat"]: r for r in seat_rows}
    groups = {}
    for th in things.values():
        for x in th["stints"]:
            if x["seat"] == "kevin": continue                       # blues are cards, not seat work
            role = ROLE.get(x["seat"], x["seat"])
            g = groups.setdefault(role, {"role": role, "seats": set(), "stints": [], "yellow": None, "next": None, "racing": False})
            g["seats"].add(x["seat"]); g["stints"].append(x)
            r = srow.get(x["seat"]) or {}
            if r.get("yellow") == "double" or (g["yellow"] != "double" and r.get("yellow")): g["yellow"] = r.get("yellow") or g["yellow"]
            if r.get("next") and not g["next"]: g["next"] = r["next"]
            if x["s"] == "green": g["racing"] = True
    for g in groups.values():
        g["seats"] = sorted(g["seats"])
        g["stints"].sort(key=lambda x: (0 if x["s"] == "green" else (1 if x.get("stalled") else (2 if x["s"] == "blue" else 3)), x["id"]))
        g["stalled"] = sum(1 for x in g["stints"] if x.get("stalled"))
        g["queued"] = sum(1 for x in g["stints"] if x["s"] == "open" and not x.get("stalled"))
        # a role's flag is the worst of: its seats' sector yellow, OR its own stalls — stalled work with no receipt IS a sector
        # problem even when the runner's slot ran (racing over 5 stalls is this morning's false green, one level up).
        if not g["yellow"] and g["stalled"]: g["yellow"] = "double" if g["stalled"] >= 3 else "single"
    yrank = {"double": 0, "single": 1}
    by_seat = sorted(groups.values(), key=lambda g: (yrank.get(g["yellow"], 2), not g["racing"], -len(g["stints"]), g["role"]))
    # per-team crew counts (stint #329): fold into each team's thing
    for gc in glance_crews:
        bay = gc["bay"]
        if bay in things:
            things[bay].setdefault("crews", []).append(gc)
    for th in things.values():
        th["crews_racing"] = len(th.get("crews") or [])
    return {"at": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"), "things": list(things.values()), "queue": queue, "sessions": list(sessions), "panel": panel,
            "flags": lights, "seats": seat_rows, "by_seat": by_seat,
            "crews": glance_crews, "prs": PRS,
            "calls": calls, "roster": [{"seat": k, **v} for k, v in ROSTER.items()],
            "teams": [{**v, "re_role": ROSTER.get(v["race_engineer"] or "", {}).get("role", "Race engineer")} for v in TEAMS.values()],
            "since": since_block(stints, races),
            "radio": radio_thread(),
            "races": [{"id": k, "title": r.get("title",""), "state": r.get("state","racing"), "target": r.get("target_week",""),
                       "finish_line": r.get("finish_line",""), "stint_ids": r.get("stint_ids") or [],
                       "done_pct": race_done_pct(r, stints)} for k, r in races.items() if r.get("state") != "finished"]}

# ── render ───────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--company", default="all"); ap.add_argument("--out", help="write the JSON atomically to this path instead of stdout"); ap.add_argument("--json", action="store_true", help="emit the glance JSON Toto renders (leg 2, 9/12) instead of the text board"); ap.add_argument("--race", default="T1", help="race tag (default T1) · all · backlog")
    a = ap.parse_args()
    seats = {k: seat_state(k) for k in SEATS}
    flags = open_flags()
    crews = load_crews()
    in_flight = {k: "fire" for k, v in seats.items() if v["lock"]}
    stints = load_stints(in_flight, crews)   # receipts/stints.jsonl — the only source; crews joined for live status
    races = load_races()
    # merge race metadata into stints by stint_ids
    for s in stints:
        for rid, r in races.items():
            if s["id"] in r.get("stint_ids", []):
                s["race"] = rid
                s["target_week"] = r.get("target_week", "")
                s["finish_line"] = r.get("finish_line", "")
                s["race_title"] = r.get("title", "")
                drift, note = race_drift(r)
                s["drift"] = drift + (" " + note if note else "")
                break
        else:
            s["race"] = None; s["drift"] = ""
    # THE DESK IS READ BEFORE THE RACE FILTER. A session is the owner's own sitting, not a race entry: #298 is tagged race:ast-t1
    # and would vanish from a T1 board, taking Kevin's booked session with it. His Today is one calendar across every race.
    sessions = session_rows(stints)
    # THE RACE FILTER (Kevin 9/12 "pick the race"): the board shows THIS race's stints + fires + blocked-on-Kevin.
    # Everything tagged `backlog` is the programme backlog — off the active board unless asked for.
    race_tag = f"race:{a.race.lower()}"
    kevin_rows = []
    if a.race == "backlog":
        stints = [s for s in stints if "backlog" in s["tags"]]
    elif a.race != "all":
        stints = [s for s in stints if race_tag in s["tags"] or "fire" in s["tags"] or s["seat"] == "kevin"]
        stints = [s for s in stints if "backlog" not in s["tags"] or s["seat"] == "kevin"]
    kevin_rows = [s for s in stints if s["seat"] == "kevin"]
    stints = [s for s in stints if s["seat"] != "kevin"]

    if a.json:
        payload = json.dumps(glance_json(stints, kevin_rows, flags, seats, races, sessions, crews), indent=1, ensure_ascii=False)
        if getattr(a, "out", None):                      # atomic: the glass must never read a half-written glance (9/13 06:05Z it did)
            tmp = a.out + ".tmp"; open(tmp, "w").write(payload); os.replace(tmp, a.out)
        else: print(payload)
        return

    print(f"BOARD · {NOW:%a %d %b %H:%M}Z · race {a.race.upper() if a.race not in ('all','backlog') else a.race}" + ("  (pre-season testing T1 · Sep 14–27 · Block 3 wk 8→10)" if a.race.upper()=="T1" else ""))
    print("FLAGS   " + (" · ".join(f"{'🟡' if f['flag']=='SC' else '🟠' if f['flag']=='VSC' else '🔴'} {f['flag']} {f['scope'].split(' (')[0]} · lifter {f['lifter']} · {f['thrown'][-6:]}" for f in flags) or "🟢 green — race pace"))
    print()
    p1s = team_open_p1s()
    for co in ("studio-b", "asthetik"):
        if a.company not in ("all", co): continue
        rows = [s for s in stints if s["company"] == co]
        rows.sort(key=lambda s: ("🔥" not in s["state"], "🟢" not in s["state"], "🟡" not in s["state"], s["pri"] != "high", s["id"]))
        n_r = sum("🟢" in s["state"] for s in rows); n_s = sum("🟡" in s["state"] for s in rows); n_b = sum("🔵" in s["state"] for s in rows); n_q = sum("⚪" in s["state"] for s in rows)
        # GUARD 6 (stint #246): a team whose registered repos carry an open zoom-intake/customer + P1
        # issue prints YELLOW here regardless of the stints' own colours — the stint ledger has no row
        # for a customer bug nobody has filed a stint for yet (Ästhetik ca#376/377/388, 9/13 all-day green).
        p1rec = p1s.get(co) or {"count": 0, "issues": []}
        p1_flag = f" 🟡 CUSTOMER P1 ×{p1rec['count']}" if p1rec["count"] else ""
        n_crew = sum(1 for c in crews if c.get("bay") == co)
        crew_flag = f" ⛽ {n_crew} racing" if n_crew else ""
        print(f"{COMPANY_LABEL[co]:<12} {len(rows)} stints · 🟢{n_r} 🟡{n_s} 🔵{n_b} ⚪{n_q}{p1_flag}{crew_flag}")
        if p1rec["count"]:
            for iss in p1rec["issues"]: print(f"    🟡 OPEN CUSTOMER P1  {iss}")
        if not rows: print("  (no stints in receipts/stints.jsonl for this bay)")
        for s in rows:
            d = (" " + s.get("drift","")) if s.get("drift") else ""
            print(f"  {s['state']+d:<32} {('#'+str(s['id'])):>4}  {s['seat']:<14} {s['age']:>4}  {s['title']}")
        print()
    # RACE SUMMARY — the race-level view (burn+drift from races.jsonl, stints from stints.jsonl)
    active = {k: v for k, v in races.items() if v.get("state") != "finished"}
    if active:
        print("RACES")
        for k, r in sorted(active.items(), key=lambda x: {"racing":0,"stalled":1}.get(x[1].get("state","racing"),0)):
            drift_icon, drift_note = race_drift(r)
            n_ids = len(r.get("stint_ids", []))
            done = sum(1 for s in stints if s["id"] in r.get("stint_ids", []) and "STALLED" not in s["state"])
            burn = f"{done}/{n_ids}" if n_ids else "—"
            tw = "· target " + r["target_week"][5:] if r.get("target_week") else ""
            print(f"  {drift_icon} {k:<24} burn {burn:<6} {r.get('state','racing'):<8} {tw}  {r['title']}")
        print()
    print("SEATS")
    for k, s in seats.items():
        flag = "● lap in flight" if s["lock"] else ("○ idle" if s["last"] else "○ never ran")
        extra = []
        if s["missed"]: extra.append(f"🟡 MISSED SLOT {s['missed']}")
        if s["status"] and s["status"] not in ("complete", "ok", None): extra.append(f"last={s['status']}")
        if s["rearm"]: extra.append(f"re-arm {s['rearm'][11:16]}Z")
        if s["pending"] not in (0, None): extra.append(f"{s['pending']} pending")
        hrs = ",".join(f"{h:02d}" for h in s["hours"]) if s["hours"] else "on demand"
        print(f"  {k:<15} {flag:<16} last {age(s['last']):>4}  slots {hrs:<12} {' · '.join(extra)}")
    print()
    kev = kevin_rows
    print(f"BLOCKED ON KEVIN ({len(kev)}, by tag — probe each before it becomes an ask, #474)")
    for s in kev: print(f"  #{s['id']:<4} {s['age']:>4}  {s['title'][:80]}")
    # 9/14 23:4xZ (Kevin: "bottleneck at the RE"): the door's flags — undrafted reads, by race engineer — on the TEXT board too. The
    # RE-ae laps ran this board eight times on 9/14 and never saw the eight flags on Kevin's glass: pr: rows lived only in --json.
    # Read from the tick's glance so the rows are the same ones Toto shows (and no extra gh calls on the text path).
    try:
        gq = json.load(open(os.path.join(BRAIN, "library/design/cockpit-spike-1/glance.json"), encoding="utf-8")).get("queue", [])
        und = [q for q in gq if isinstance(q.get("id"), str) and q["id"].startswith("pr:") and not q.get("card") and a.company in ("all", q.get("bay"))]
        if und:
            print(f"\nDOOR FLAGS UNDRAFTED ({len(und)}) — the race engineer's read: card = receipts/cards/<bay>/pr-<repo>-<n>.md (five ## sections, card-lint 0); the runner names these into the RE's lap")
            for q in und:
                repo, n = q["id"][3:].split("#", 1)
                print(f"  {q['id']:<34} {str(q.get('age') or ''):>4}  {q.get('re') or '?':<18} https://github.com/studio-b-ai/{repo}/pull/{n}")
    except Exception as e:
        print(f"  [board] door flags unreadable from the glance: {e!r}")
    stalled_fire = [s for s in stints if s["state"].startswith("🔥") and "STALLED" in s["state"]]
    if stalled_fire: print("\n🔥🟡 STALLED FIRES — a fire with no receipt in 48h: " + " · ".join(f"#{s['id']} {s['seat']}" for s in stalled_fire))
    # THE BOX TEMPLATE'S "EVERY TEAM FIRES + P1S" LINE (Guard 6, stint #246): one row per team, always
    # printed — a team with zero fires and zero open customer P1s still gets its row, so the box can
    # never skip a team by omission. Read from GitHub per the kit's own repos:, never from the stint
    # ledger (a live customer P1 may have no stint at all yet).
    print("\nEVERY TEAM — fires + open customer P1s (box template, Guard 6)")
    for team in TEAMS.values():
        co = team["key"]
        n_fire = sum(1 for s in stints if s["company"] == co and s["state"].startswith("🔥"))
        rec = p1s.get(co) or {"count": 0, "issues": []}
        flag = "🟡" if rec["count"] else ("🔥" if n_fire else "🟢")
        print(f"  {flag} {COMPANY_LABEL.get(co, co):<12} fires {n_fire} · open customer P1s {rec['count']}" + (
            "  → " + " · ".join(rec["issues"]) if rec["count"] else ""))

if __name__ == "__main__": main()
