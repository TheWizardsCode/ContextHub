"""Tests for the herdr even-completion grid rebalance algorithm.

These tests validate the grid growth policy, emitted JSON-RPC messages,
and verified shapes without requiring a live herdr session.

The mock server is a stateful herdr simulator: it maintains a layout tree
(layout.export), applies pane.split by replacing the target pane with a
split node, and applies layout.set_split_ratio by walking boolean paths
(True = second child, matching the reference implementation).

Run with:
    cd /path/to/ContextHub
    PYTHONPATH=. python3 -m pytest packages/herdr/shared/tests/test_grid.py -v
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

# Ensure the shared directory is on the path so grid.py can be imported
_SHARED_DIR = Path(__file__).resolve().parent.parent
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from grid import (
    GridBuilder,
    compute_rebalance_ratios,
    parse_grid_tree,
    rpc,
)

# ---------------------------------------------------------------------------
# Tree node helpers (same shape as layout.export)
# ---------------------------------------------------------------------------

def P(pane_id: str) -> dict:
    """A pane leaf node."""
    return {"type": "pane", "pane_id": pane_id}


def S(direction: str, ratio: float, first: dict, second: dict) -> dict:
    """A split node."""
    return {"type": "split", "direction": direction, "ratio": ratio,
            "first": first, "second": second}


def right(first: dict, second: dict, ratio: float = 0.5) -> dict:
    return S("right", ratio, first, second)


def down(first: dict, second: dict, ratio: float = 0.5) -> dict:
    return S("down", ratio, first, second)


def chain(pane_ids: list[str]) -> dict:
    """Build a down-chain: root pane + down-splits whose second child continues.

    e.g. chain(["p3", "p6"]) = down(p3, p6)  (p3 top, p6 below)
    """
    if not pane_ids:
        return P("")
    node = P(pane_ids[-1])
    for pid in reversed(pane_ids[:-1]):
        node = down(P(pid), node)
    return node


def grid_tree(
    anchor: str,
    s1_right: str,
    r1: tuple[str, str] | None,
    b: dict | None,
) -> dict:
    """Build the full grid tree.

    root: right [anchor, S1]
    S1: down [R1, B]
    R1: right [a, b]     (when r1 is not None)
    B: right [L, R]      (when b is a right split)
    """
    if r1 is None:
        s1 = P(s1_right)
    else:
        r1_node = right(P(r1[0]), P(r1[1]))
        if b is None:
            s1 = down(r1_node, P(""))
        else:
            s1 = down(r1_node, b)
    return right(P(anchor), s1)


def b_node(l_chain: list[str], r_chain: list[str]) -> dict:
    """B: right [L_col_root, R_col_root] with down-chains."""
    return right(chain(l_chain), chain(r_chain))


# ---------------------------------------------------------------------------
# Stateful mock herdr server
# ---------------------------------------------------------------------------

class MockHerdr:
    """Stateful in-memory herdr simulator over TCP.

    Maintains a layout tree; answers layout.export, pane.split and
    layout.set_split_ratio requests. Records every received frame.
    """

    def __init__(self, root: dict | None = None, tab_id: str = "w1:t1",
                 anchor: str = "w1:p80"):
        self.tab_id = tab_id
        self.anchor = anchor
        self.root = root if root is not None else P(anchor)
        self.frames: list[dict] = []
        self._counter = 100
        self._server_socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> int:
        self._server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_socket.bind(("127.0.0.1", 0))
        self._server_socket.listen(5)
        self._server_socket.settimeout(0.2)
        port = self._server_socket.getsockname()[1]
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        return port

    def stop(self) -> None:
        self._stop.set()
        if self._server_socket is not None:
            try:
                self._server_socket.close()
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2)

    # -- server loop ---------------------------------------------------------

    def _accept_loop(self) -> None:
        assert self._server_socket is not None
        while not self._stop.is_set():
            try:
                conn, _ = self._server_socket.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with conn:
                conn.settimeout(2.0)
                try:
                    data = b""
                    while b"\n" not in data:
                        chunk = conn.recv(65536)
                        if not chunk:
                            break
                        data += chunk
                    if not data:
                        continue
                    frame = json.loads(data.decode())
                    with self._lock:
                        self.frames.append(frame)
                        response = self._handle(frame)
                    conn.sendall((json.dumps(response) + "\n").encode())
                except (OSError, ValueError, KeyError):
                    # Drop malformed/closed connections; keep serving
                    try:
                        conn.sendall((json.dumps({"result": {}}) + "\n").encode())
                    except OSError:
                        pass

    # -- RPC handlers --------------------------------------------------------

    def _handle(self, frame: dict) -> dict:
        method = frame.get("method", "")
        params = frame.get("params", {})
        if method == "layout.export":
            return self._on_export(params)
        if method == "pane.split":
            return self._on_split(params)
        if method == "layout.set_split_ratio":
            self._on_set_ratio(params)
            return {"result": {}}
        return {"result": {}}

    def _on_export(self, params: dict) -> dict:
        return {
            "result": {
                "type": "layout_export",
                "layout": {
                    "workspace_id": "w1",
                    "tab_id": self.tab_id,
                    "zoomed": False,
                    "focused_pane_id": params.get("pane_id", self.anchor),
                    "root": self.root,
                },
            }
        }

    def _on_split(self, params: dict) -> dict:
        target = params.get("target_pane_id", "")
        direction = params.get("direction", "right")
        ratio = params.get("ratio", 0.5)
        new_id = self._next_pane_id()
        self.root = self._replace_pane(self.root, target, direction, ratio, new_id)
        return {"result": {"pane": {"pane_id": new_id}}}

    def _on_set_ratio(self, params: dict) -> None:
        path = params.get("path", [])
        ratio = params.get("ratio", 0.5)
        node = self.root
        for step in path:
            if not isinstance(node, dict) or node.get("type") != "split":
                return
            node = node.get("second") if step else node.get("first")
        if isinstance(node, dict) and node.get("type") == "split":
            node["ratio"] = ratio

    # -- tree manipulation -----------------------------------------------------

    def _replace_pane(self, node: dict, target: str, direction: str,
                      ratio: float, new_id: str) -> dict:
        if node.get("type") == "pane":
            if node.get("pane_id") == target:
                return S(direction, ratio, node, P(new_id))
            return node
        if node.get("type") == "split":
            return S(
                node["direction"], node["ratio"],
                self._replace_pane(node["first"], target, direction, ratio, new_id),
                self._replace_pane(node["second"], target, direction, ratio, new_id),
            )
        return node

    def _next_pane_id(self) -> str:
        self._counter += 1
        return f"w1:p{self._counter}"

    # -- query helpers ---------------------------------------------------------

    def pane_ids(self) -> list[str]:
        out: list[str] = []

        def walk(node: dict) -> None:
            if node.get("type") == "pane":
                out.append(node.get("pane_id", ""))
            elif node.get("type") == "split":
                walk(node["first"])
                walk(node["second"])

        walk(self.root)
        return out

    def ratio_at(self, path: list[bool]) -> float | None:
        node = self.root
        for step in path:
            if not isinstance(node, dict) or node.get("type") != "split":
                return None
            node = node.get("second") if step else node.get("first")
        if isinstance(node, dict) and node.get("type") == "split":
            return node.get("ratio")
        return None

    def split_calls(self) -> list[dict]:
        return [f for f in self.frames if f.get("method") == "pane.split"]

    def ratio_calls(self) -> list[dict]:
        return [f for f in self.frames if f.get("method") == "layout.set_split_ratio"]


@pytest.fixture
def mock():
    """Provide a stateful mock herdr server; grid connects via HERDR_SOCKET_PORT."""
    server = MockHerdr()
    port = server.start()
    os.environ["HERDR_SOCKET_PORT"] = str(port)
    os.environ.pop("HERDR_SOCKET_PATH", None)
    yield server
    server.stop()
    os.environ.pop("HERDR_SOCKET_PORT", None)


def build_grid(anchor: str, steps: int) -> list[str]:
    """Run *steps* add_pane() calls against the live mock; return new pane ids."""
    builder = GridBuilder(anchor)
    return [builder.add_pane() for _ in range(steps)]


# ---------------------------------------------------------------------------
# Tests: parse / state detection
# ---------------------------------------------------------------------------

class TestStateDetection:
    """parse_grid_tree classification of the layout.export tree."""

    def test_fresh_single_pane(self):
        state = parse_grid_tree({"tab_id": "w1:t1", "root": P("w1:p80")})
        assert state["k"] == 0
        assert state["is_fresh"] is True
        assert state["anchor"] == "w1:p80"

    def test_k1_right_split(self):
        state = parse_grid_tree({"tab_id": "w1:t1", "root": right(P("w1:p80"), P("w1:p81"))})
        assert state["k"] == 1
        assert state["is_fresh"] is False
        assert state["l_col"] == []
        assert state["r_col"] == []

    def test_k2_down_split(self):
        state = parse_grid_tree({
            "tab_id": "w1:t1",
            "root": right(P("w1:p80"), down(P("w1:p81"), P("w1:p82"))),
        })
        assert state["k"] == 2
        assert state["l_col"] == []
        assert state["r_col"] == []

    def test_k3_row1_pair(self):
        state = parse_grid_tree({
            "tab_id": "w1:t1",
            "root": right(P("w1:p80"),
                          down(right(P("w1:p81"), P("w1:p83")), P("w1:p82"))),
        })
        assert state["k"] == 3
        assert state["l_col"] == []
        assert state["r_col"] == []

    def test_k4_two_by_two(self):
        state = parse_grid_tree({
            "tab_id": "w1:t1",
            "root": right(P("w1:p80"),
                          down(right(P("w1:p81"), P("w1:p83")),
                               right(P("w1:p82"), P("w1:p84")))),
        })
        assert state["k"] == 4
        assert state["l_col"] == ["w1:p82"]
        assert state["r_col"] == ["w1:p84"]

    def test_k5_odd_tall(self):
        state = parse_grid_tree({
            "tab_id": "w1:t1",
            "root": right(P("w1:p80"),
                          down(right(P("w1:p81"), P("w1:p83")),
                               right(chain(["w1:p82", "w1:p85"]), P("w1:p84")))),
        })
        assert state["k"] == 5
        assert state["l_col"] == ["w1:p82", "w1:p85"]
        assert state["r_col"] == ["w1:p84"]

    def test_unrecognised_root_falls_back_fresh(self):
        state = parse_grid_tree({"tab_id": "w1:t1", "root": None})
        assert state["is_fresh"] is True

    def test_nested_first_child_falls_back_fresh(self):
        # root: right [ right[pane, pane], pane ] — first child is a split,
        # not a pane (e.g. panes added by pre-grid code). No anchor exists to
        # grow from, so the state must be treated as fresh so the caller falls
        # back to splitting the current pane right.
        state = parse_grid_tree({
            "tab_id": "w1:t1",
            "root": right(right(P("w1:p26"), P("w1:p28")), P("w1:p27")),
        })
        assert state["is_fresh"] is True
        assert state["anchor"] == ""
        assert state["k"] == 0


# ---------------------------------------------------------------------------
# Tests: rebalance ratios
# ---------------------------------------------------------------------------

class TestRebalanceRatios:
    """compute_rebalance_ratios output."""

    def test_k2_rebalance(self):
        r = compute_rebalance_ratios(0, 1)
        assert r["S1_ratio"] == pytest.approx(0.5)
        assert r["R1_ratio"] == 0.5
        assert "B_ratio" not in r  # only one column exists yet

    def test_k4_rebalance(self):
        r = compute_rebalance_ratios(1, 1)
        assert r["S1_ratio"] == pytest.approx(0.5)
        assert r["R1_ratio"] == 0.5
        assert r["B_ratio"] == 0.5
        # No chain keys when n == 1 (the last cell is a leaf)
        assert not any(k.startswith("L_col_") for k in r)
        assert not any(k.startswith("R_col_") for k in r)

    def test_k6_rebalance(self):
        r = compute_rebalance_ratios(2, 2)
        assert r["S1_ratio"] == pytest.approx(1.0 / 3)
        assert r["R1_ratio"] == 0.5
        assert r["B_ratio"] == 0.5
        assert r["L_col_0_ratio"] == pytest.approx(0.5)
        assert r["R_col_0_ratio"] == pytest.approx(0.5)

    def test_k12_rebalance(self):
        r = compute_rebalance_ratios(6, 6)
        assert r["S1_ratio"] == pytest.approx(1.0 / 7)
        # chain cells j=0..4; last cell is a leaf
        assert r["L_col_0_ratio"] == pytest.approx(1.0 / 6)
        assert r["L_col_4_ratio"] == pytest.approx(0.5)
        assert len([k for k in r if k.startswith("L_col_")]) == 5
        assert len([k for k in r if k.startswith("R_col_")]) == 5

    def test_odd_k_shorter_column_uses_longer_base(self):
        # k=13: L=7, R=6 → base=7; R uses the same denominators so its
        # last cell goes tall
        r = compute_rebalance_ratios(7, 6)
        assert r["S1_ratio"] == pytest.approx(1.0 / 8)
        for j in range(5):
            assert r[f"R_col_{j}_ratio"] == pytest.approx(1.0 / (7 - j))
        assert len([k for k in r if k.startswith("R_col_")]) == 5
        assert len([k for k in r if k.startswith("L_col_")]) == 6


# ---------------------------------------------------------------------------
# Tests: growth policy (stateful mock, sequential add_pane)
# ---------------------------------------------------------------------------

class TestGrowthPolicy:
    """The even-completion growth policy from a fresh grid."""

    def test_k1_splits_anchor_right(self, mock):
        new_ids = build_grid("w1:p80", 1)
        assert new_ids == ["w1:p101"]
        splits = mock.split_calls()
        assert len(splits) == 1
        assert splits[0]["params"]["target_pane_id"] == "w1:p80"
        assert splits[0]["params"]["direction"] == "right"
        assert splits[0]["params"]["ratio"] == 0.5
        assert splits[0]["params"]["focus"] is False
        assert mock.ratio_calls() == []

    def test_unrecognised_layout_falls_back_to_plain_right_split(self, mock):
        # Layout not built by the grid code (e.g. panes added by pre-grid
        # scripts or manual splits): root: right [ right[pane, pane], pane ].
        # No anchor exists, so add_pane must fall back to a plain right-split
        # of the current pane rather than splitting some wrong subtree.
        mock.root = right(right(P("w1:p26"), P("w1:p28")), P("w1:p27"))
        builder = GridBuilder("w1:p26")
        new_id = builder.add_pane()
        assert new_id == "w1:p101"
        splits = mock.split_calls()
        assert len(splits) == 1
        assert splits[0]["params"]["target_pane_id"] == "w1:p26"
        assert splits[0]["params"]["direction"] == "right"
        assert mock.ratio_calls() == []

    def test_k2_splits_s1_down(self, mock):
        build_grid("w1:p80", 2)
        splits = mock.split_calls()
        assert len(splits) == 2
        # second split: S1 (right of anchor) down
        assert splits[1]["params"]["target_pane_id"] == "w1:p101"
        assert splits[1]["params"]["direction"] == "down"
        # S1 ratio call
        ratios = mock.ratio_calls()
        assert len(ratios) == 1
        assert ratios[0]["params"]["path"] == [True]
        assert ratios[0]["params"]["ratio"] == pytest.approx(0.5)

    def test_k3_splits_r1_right(self, mock):
        build_grid("w1:p80", 3)
        splits = mock.split_calls()
        assert len(splits) == 3
        # third split: R1 (first child of the down split) right
        assert splits[2]["params"]["target_pane_id"] == "w1:p101"
        assert splits[2]["params"]["direction"] == "right"
        # rebalance(0,1): S1 + R1; plus the earlier k=2 S1 ratio → 3 total
        ratios = mock.ratio_calls()
        assert len(ratios) == 3
        assert ratios[1]["params"]["path"] == [True]
        assert ratios[2]["params"]["path"] == [True, False]

    def test_k4_splits_bottom_right(self, mock):
        new_ids = build_grid("w1:p80", 4)
        assert new_ids[-1] == "w1:p104"
        splits = mock.split_calls()
        assert len(splits) == 4
        # fourth split: bottom pane (second child of the down split) right
        assert splits[3]["params"]["target_pane_id"] == "w1:p102"
        assert splits[3]["params"]["direction"] == "right"
        # rebalance(1,1): S1 + R1 + B
        ratios = mock.ratio_calls()
        # 1 (k2 S1) + 2 (k3 S1+R1) + 3 (k4 S1+R1+B) = 6
        assert len(ratios) == 6
        paths = [c["params"]["path"] for c in ratios]
        assert [True, True] in paths  # B ratio

    def test_k5_grows_left_column(self, mock):
        new_ids = build_grid("w1:p80", 5)
        assert new_ids[-1] == "w1:p105"
        splits = mock.split_calls()
        # 5th split: L_col[-1] (bottom-left) down
        assert splits[4]["params"]["target_pane_id"] == "w1:p102"
        assert splits[4]["params"]["direction"] == "down"
        # now L_col=[p102, p105], R_col=[p104]
        state = parse_grid_tree({"tab_id": "w1:t1", "root": mock.root})
        assert state["l_col"] == ["w1:p102", "w1:p105"]
        assert state["r_col"] == ["w1:p104"]

    def test_k6_completes_row(self, mock):
        build_grid("w1:p80", 6)
        splits = mock.split_calls()
        # 6th split: R_col[-1] (bottom-right) down
        assert splits[5]["params"]["target_pane_id"] == "w1:p104"
        assert splits[5]["params"]["direction"] == "down"
        state = parse_grid_tree({"tab_id": "w1:t1", "root": mock.root})
        assert state["l_col"] == ["w1:p102", "w1:p105"]
        assert state["r_col"] == ["w1:p104", "w1:p106"]

    def test_growth_alternates_columns(self, mock):
        build_grid("w1:p80", 13)
        splits = mock.split_calls()
        # splits[3] is the k=4 split (R1 right → w1:p102); growth after that
        # alternates starting with L at odd k: k5:L, k6:R, k7:L, ... k13:L → 9 splits
        targets_after_k4 = [s["params"]["target_pane_id"] for s in splits[4:]]
        assert targets_after_k4 == [
            "w1:p102",  # k5: L_col[-1] (bottom-left)
            "w1:p104",  # k6: R_col[-1] (bottom-right)
            "w1:p105",  # k7: L_col[-1]
            "w1:p106",  # k8: R_col[-1]
            "w1:p107",  # k9: L_col[-1]
            "w1:p108",  # k10: R_col[-1]
            "w1:p109",  # k11: L_col[-1]
            "w1:p110",  # k12: R_col[-1]
            "w1:p111",  # k13: L_col[-1]
        ]
        dirs_after_k4 = [s["params"]["direction"] for s in splits[3:]]
        assert dirs_after_k4 == ["right"] + ["down"] * 9


# ---------------------------------------------------------------------------
# Tests: verified shapes
# ---------------------------------------------------------------------------

class TestVerifiedShapes:
    """k=12 → 6×2 and k=14 → 7×2 (validated against herdr 0.7.5)."""

    def test_k12_six_by_two(self, mock):
        build_grid("w1:p80", 12)
        state = parse_grid_tree({"tab_id": "w1:t1", "root": mock.root})
        # k=12 → 6x2 grid: header row + 5 chain rows → L=5, R=5
        assert len(state["l_col"]) == 5
        assert len(state["r_col"]) == 5
        assert state["k"] == 12
        # S1 ratio 1/(1+base) with base = 5 → 1/6
        assert mock.ratio_at([True]) == pytest.approx(1.0 / 6)

    def test_k14_seven_by_two(self, mock):
        build_grid("w1:p80", 14)
        state = parse_grid_tree({"tab_id": "w1:t1", "root": mock.root})
        # k=14 → 7x2 grid: header row + 6 chain rows → L=6, R=6
        assert len(state["l_col"]) == 6
        assert len(state["r_col"]) == 6
        assert state["k"] == 14
        assert mock.ratio_at([True]) == pytest.approx(1.0 / 7)

    def test_odd_k_temporary_tall_cell(self, mock):
        build_grid("w1:p80", 13)
        state = parse_grid_tree({"tab_id": "w1:t1", "root": mock.root})
        # k=13 (odd): L grew one more than R → L=6, R=5 (tall cell in R)
        assert len(state["l_col"]) == 6
        assert len(state["r_col"]) == 5


# ---------------------------------------------------------------------------
# Tests: anchor never split; 50% × 100%
# ---------------------------------------------------------------------------

class TestAnchor:
    """The anchor pane is never split and keeps 50% × 100%."""

    def test_anchor_never_a_split_target(self, mock):
        build_grid("w1:p80", 14)
        # The anchor IS split once at k=1 (the initial right split that starts
        # the grid), but must never be a target again afterwards.
        for s in mock.split_calls()[1:]:
            assert s["params"]["target_pane_id"] != "w1:p80"

    def test_anchor_still_leaf_in_root(self, mock):
        build_grid("w1:p80", 14)
        # root.first must remain the original anchor pane
        assert mock.root["type"] == "split"
        assert mock.root["first"] == P("w1:p80")
        assert mock.root["direction"] == "right"

    def test_s1_ratio_keeps_anchor_half_width(self, mock):
        build_grid("w1:p80", 14)
        # S1 (root.second, i.e. path [True]) ratio = 1/(1+base) ≤ 0.5,
        # so the anchor keeps ≥ 50% of the width
        assert mock.ratio_at([True]) <= 0.5


# ---------------------------------------------------------------------------
# Tests: grid continuation (existing perfect grid → complete rows)
# ---------------------------------------------------------------------------

class TestGridContinuation:
    """Adding panes to an existing perfect grid completes rows at even counts."""

    def test_continue_from_k12_perfect_grid(self, mock):
        build_grid("w1:p80", 12)
        # now k=12 (6x2, L=R=5). Two more panes → k=14 (7x2, L=R=6)
        build_grid("w1:p80", 2)
        state = parse_grid_tree({"tab_id": "w1:t1", "root": mock.root})
        assert len(state["l_col"]) == 6
        assert len(state["r_col"]) == 6

    def test_even_k_always_completes_row(self, mock):
        for k in (4, 6, 8, 10, 12):
            server = MockHerdr()
            port = server.start()
            os.environ["HERDR_SOCKET_PORT"] = str(port)
            try:
                build_grid("w1:p80", k)
                state = parse_grid_tree({"tab_id": "w1:t1", "root": server.root})
                assert len(state["l_col"]) == len(state["r_col"]), f"k={k} not perfect"
            finally:
                server.stop()
        os.environ.pop("HERDR_SOCKET_PORT", None)


# ---------------------------------------------------------------------------
# Tests: emitted JSON-RPC message format
# ---------------------------------------------------------------------------

class TestJsonRpcFormat:
    """Frames are newline-delimited JSON-RPC with id/method/params."""

    def test_frame_shape(self, mock):
        build_grid("w1:p80", 2)
        assert len(mock.frames) >= 3
        for f in mock.frames:
            assert "id" in f
            assert "method" in f
            assert "params" in f
            assert isinstance(f["params"], dict)

    def test_set_split_ratio_paths_are_bool_lists(self, mock):
        build_grid("w1:p80", 6)
        for c in mock.ratio_calls():
            path = c["params"]["path"]
            assert isinstance(path, list)
            assert all(isinstance(p, bool) for p in path)
            assert isinstance(c["params"]["ratio"], (int, float))

    def test_ratios_reference_paths(self, mock):
        build_grid("w1:p80", 8)
        paths = [c["params"]["path"] for c in mock.ratio_calls()]
        # S1, R1, B and chain paths all present
        assert [True] in paths
        assert [True, False] in paths
        assert [True, True] in paths
        assert [True, True, False] in paths  # L_col root
        assert [True, True, True] in paths   # R_col root
        assert [True, True, False, True] in paths  # L_col cell 1
        assert [True, True, True, True] in paths   # R_col cell 1


# ---------------------------------------------------------------------------
# Tests: safe operations only
# ---------------------------------------------------------------------------

class TestSafeOperations:
    """Only pane.split and layout.set_split_ratio are ever emitted."""

    @pytest.mark.parametrize("steps", [1, 4, 8, 14])
    def test_no_forbidden_methods(self, mock, steps):
        build_grid("w1:p80", steps)
        methods = {f.get("method") for f in mock.frames}
        assert methods.issubset({"pane.split", "layout.set_split_ratio", "layout.export"}), methods


# ---------------------------------------------------------------------------
# Tests: error handling & CLI
# ---------------------------------------------------------------------------

class TestErrorsAndCli:
    """Socket failures and the CLI contract."""

    def test_socket_failure_raises(self):
        os.environ["HERDR_SOCKET_PORT"] = "1"  # port 1 is not listening
        try:
            builder = GridBuilder("w1:p80")
            with pytest.raises(OSError):
                builder.add_pane()
        finally:
            os.environ.pop("HERDR_SOCKET_PORT", None)

    def test_rpc_error_surfaces(self):
        # An rpc to a closed socket should raise (not hang)
        os.environ["HERDR_SOCKET_PORT"] = "1"
        try:
            with pytest.raises(OSError):
                rpc("pane.split", {"target_pane_id": "w1:p80", "direction": "right"})
        finally:
            os.environ.pop("HERDR_SOCKET_PORT", None)

    def test_cli_prints_pane_id_json(self, mock, tmp_path):
        env = dict(os.environ)
        env["HERDR_SOCKET_PORT"] = str(os.environ["HERDR_SOCKET_PORT"])
        result = subprocess.run(
            [sys.executable, str(_SHARED_DIR / "grid.py"), "w1:p80"],
            capture_output=True, text=True, env=env, cwd=str(_SHARED_DIR),
        )
        assert result.returncode == 0, result.stderr
        out = json.loads(result.stdout)
        assert "pane_id" in out
        assert out["pane_id"] == "w1:p101"

    def test_cli_failure_nonzero_exit(self):
        env = dict(os.environ)
        env["HERDR_SOCKET_PORT"] = "1"
        result = subprocess.run(
            [sys.executable, str(_SHARED_DIR / "grid.py"), "w1:p80"],
            capture_output=True, text=True, env=env, cwd=str(_SHARED_DIR),
        )
        assert result.returncode != 0
        assert "Error" in result.stderr
