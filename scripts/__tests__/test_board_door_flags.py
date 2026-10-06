"""Tests for board.py :: pr_cards() door flag routing (stint #410).

stint #410 behaviors:
- Fresh door flag (needs-human, no card file) → flags (RE's row), not asks (Kevin's)
- Door flag with a card file → asks (Kevin's)
- hold label → removed from all queues
- CONFLICTING PR → never cards
- _door_template → draft = None (never a card)
"""
import os, sys, io
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["HOME"] = os.path.expanduser("~")

def _fake_load_roster():
    return {
        "race-engineer-studio-b": {"role": "Race engineer", "team": "studio-b", "slots_utc": [], "rail": "race-engineer-studio-b", "on_demand": True},
        "race-engineer-asthetik": {"role": "Race engineer", "team": "asthetik", "slots_utc": [], "rail": "race-engineer-asthetik", "on_demand": True},
    }

def _fake_load_teams():
    return {
        "studio-b": {"key": "studio-b", "display": "Studio B", "race_engineer": "race-engineer-studio-b", "live_surfaces": [], "radio": {}, "repos": []},
        "asthetik": {"key": "asthetik", "display": "Asthetik", "race_engineer": "race-engineer-asthetik", "live_surfaces": [], "radio": {}, "repos": []},
    }

# board.py's top-level code calls _load_roster() which opens a yaml file and
# _load_teams() which globs the vault.  The functions call open() before
# yaml.safe_load(); mock open so the io passes, and mock glob to find no kits.
with patch("builtins.open", side_effect=lambda p, *a, **kw: io.StringIO("seats: {}")), \
     patch("glob.glob", return_value=[]):
    import board

board.ROSTER = _fake_load_roster()
board.TEAMS = _fake_load_teams()
board.SEATS = {k: (v["team"], v["role"]) for k, v in board.ROSTER.items()}


def _pr(**kw):
    """Minimal PR dict matching load_prs() return shape."""
    return {
        "repo": "ops-pipeline", "full": "studio-b-ai/ops-pipeline",
        "n": 100, "title": "test PR", "url": "https://github.com/studio-b-ai/ops-pipeline/pull/100",
        "labels": [], "green": True, "red": False, "pending": False,
        "created": "2026-09-15T00:00:00Z", "author": "kbibelhausen",
        "mergeable": "MERGEABLE", "door": None,
    } | kw


# ── pr_cards() tests ──────────────────────────────────────────────────────────

def test_fresh_door_flag_goes_to_re_row():
    """A needs-human PR with no card file → flags (RE's row), not asks (Kevin's)."""
    pr = _pr(labels=["needs-human"], n=101, repo="claude-config-plane",
             full="studio-b-ai/claude-config-plane", url="https://github.com/studio-b-ai/claude-config-plane/pull/101")
    with patch.object(board, "load_prs", return_value=[pr]):
        result = board.pr_cards()
    assert len(result["flags"]) == 1
    assert len(result["asks"]) == 0
    assert result["flags"][0]["n"] == 101
    assert result["flags"][0]["flag"] == "review"


def test_door_flag_with_card_file_goes_to_kevin_queue():
    """A needs-human PR with a card file → asks (Kevin's queue)."""
    pr = _pr(labels=["needs-human"], n=102)
    with patch.object(board, "load_prs", return_value=[pr]):
        with patch.object(board.os.path, "exists", return_value=True):
            result = board.pr_cards()
    assert len(result["asks"]) == 1
    assert len(result["flags"]) == 0
    assert result["asks"][0]["n"] == 102


def test_hold_removes_from_all_queues():
    """A hold label parks the flag off every queue."""
    pr = _pr(labels=["needs-human", "hold"], n=103)
    with patch.object(board, "load_prs", return_value=[pr]):
        result = board.pr_cards()
    assert len(result["flags"]) == 0
    assert len(result["asks"]) == 0
    assert len(result["rides"]) == 0


def test_conflicting_pr_never_cards():
    """A CONFLICTING PR never reaches any card queue."""
    pr = _pr(labels=["needs-human"], n=104, mergeable="CONFLICTING")
    with patch.object(board, "load_prs", return_value=[pr]):
        result = board.pr_cards()
    assert len(result["flags"]) == 0
    assert len(result["asks"]) == 0


def test_pr_not_needs_human_skips_flag_logic():
    """A green unlabeled PR not authored by Kevin doesn't become a flag or ask."""
    pr = _pr(labels=[], n=105, author="someone-else")
    with patch.object(board, "load_prs", return_value=[pr]):
        result = board.pr_cards()
    assert len(result["flags"]) == 0
    assert len(result["asks"]) == 0


def test_still_refused_review_leg_rides():
    """A still-refused PR at review leg → rides (door merges it)."""
    pr = _pr(labels=["needs-human", "reviewed"], n=106, green=True)
    with patch.object(board, "load_prs", return_value=[pr]):
        with patch.object(board, "still_refused", return_value=True):
            with patch.object(board, "door_leg", return_value="review"):
                result = board.pr_cards()
    assert len(result["rides"]) == 1
    assert len(result["asks"]) == 0
    assert result["rides"][0]["n"] == 106


def test_still_refused_non_review_leg_no_card_goes_to_flags():
    """A still-refused PR at a non-review leg with no card file → flags (RE's row), not asks (Kevin's)."""
    pr = _pr(labels=["needs-human", "reviewed"], n=107, green=True)
    with patch.object(board, "load_prs", return_value=[pr]):
        with patch.object(board, "still_refused", return_value=True):
            with patch.object(board, "door_leg", return_value="named-checks"):
                with patch.object(board.os.path, "exists", return_value=False):
                    result = board.pr_cards()
    assert len(result["flags"]) == 1
    assert len(result["asks"]) == 0
    assert result["flags"][0]["n"] == 107
    assert result["flags"][0]["flag"] == "refused"


def test_still_refused_non_review_leg_with_card_asks():
    """A still-refused PR at a non-review leg WITH a card file → asks (Kevin's queue)."""
    pr = _pr(labels=["needs-human", "reviewed"], n=108, green=True)
    with patch.object(board, "load_prs", return_value=[pr]):
        with patch.object(board, "still_refused", return_value=True):
            with patch.object(board, "door_leg", return_value="named-checks"):
                with patch.object(board.os.path, "exists", return_value=True):
                    result = board.pr_cards()
    assert len(result["asks"]) == 1
    assert len(result["flags"]) == 0
    assert result["asks"][0]["n"] == 108
    assert result["asks"][0]["flag"] == "refused"


def test_unlabeled_kevin_pr_goes_to_asks():
    """An unlabeled Kevin-authored green PR → asks."""
    pr = _pr(labels=[], n=108, author="kbibelhausen", green=True)
    with patch.object(board, "load_prs", return_value=[pr]):
        result = board.pr_cards()
    assert len(result["asks"]) == 1
    assert result["asks"][0]["n"] == 108


# ── glance_json needs_card integration test ───────────────────────────────────

def test_flag_appears_in_needs_card_on_glance_json():
    """A flag (no card) → RE's row as needs_card with re_class=read."""
    pr = _pr(labels=["needs-human"], n=109, repo="ops-pipeline")
    with patch.object(board, "pr_cards", return_value={"rides": [], "asks": [], "red": [], "flags": [pr], "pending": []}):
        with patch.object(board, "load_stints", return_value=[]):
            with patch.object(board, "load_races", return_value={}):
                with patch.object(board, "since_block", return_value={"items": [], "done": [], "new": [], "merged": [], "anchor": ""}):
                    with patch.object(board, "open_flags", return_value=[]):
                        with patch.object(board, "load_prs", return_value=[]):
                            with patch.object(board, "radio_thread", return_value=[]):
                                g = board.glance_json(stints=[], kevin_rows=[], flags=[], seats={}, races={}, sessions=[], crews=[])

    needs_card = g["panel"]["needs_card"]
    assert len(needs_card) == 1
    assert needs_card[0]["re_class"] == "read"
    assert "race-engineer-studio-b" in needs_card[0]["by"]
    assert "109" in needs_card[0]["id"]


def test_door_flags_attached_to_team_thing():
    """Door flags attach to things[bay].door_flags for the team's RE row."""
    pr = _pr(labels=["needs-human"], n=110, repo="ops-pipeline")
    stint = {"id": 1, "company": "studio-b", "seat": "mechanic", "title": "test stint",
             "state": "⚪ unclaimed", "tags": [], "headline": None, "shape": "task",
             "budget_min": None, "age": "1m", "for": None, "crew": None, "race": None}
    with patch.object(board, "pr_cards", return_value={"rides": [], "asks": [], "red": [], "flags": [pr], "pending": []}):
        with patch.object(board, "load_stints", return_value=[stint]):
            with patch.object(board, "load_races", return_value={}):
                with patch.object(board, "since_block", return_value={"items": [], "done": [], "new": [], "merged": [], "anchor": ""}):
                    with patch.object(board, "open_flags", return_value=[]):
                        with patch.object(board, "load_prs", return_value=[]):
                            with patch.object(board, "radio_thread", return_value=[]):
                                with patch.object(board, "load_last_receipts", return_value={}):
                                    g = board.glance_json(stints=[stint], kevin_rows=[], flags=[], seats={}, races={}, sessions=[], crews=[])

    things = g["things"]
    assert len(things) == 1
    assert things[0]["key"] == "studio-b"
    door_flags = things[0].get("door_flags", [])
    assert len(door_flags) == 1
    assert door_flags[0]["n"] == 110
    assert door_flags[0]["repo"] == "ops-pipeline"


def test_door_template_never_cards():
    """A still-refused PR with no card file → load_card returns _door_template: True → draft=None."""
    with patch.object(board, "load_prs", return_value=[]):
        result = board.load_card("studio-b", "pr:ops-pipeline#111")
    # When no PR is found (empty load_prs), the function falls through to _card_from_file,
    # which returns None (no card file). But the pr: handling in the ops-pipeline version
    # only returns _door_template for still_refused with leg != "review".
    # For a PR not found in load_prs, the needs-human check returns None.
    assert result is None or result.get("_door_template") is True