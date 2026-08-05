#!/usr/bin/env python3
"""Grid rebalance helper for the herdr even-completion grid algorithm.

This module provides a Python helper for growing an even-completion grid of
panes to the right of a fixed left pane. The algorithm was validated against
herdr 0.7.5 and produces verified shapes: k=12 → 6×2, k=14 → 7×2.

Tree invariant (layout.export recursive tree):
  root: right [anchor, S1]
  S1: down [R1, B]
  R1: right [a, b]                    (row 1)
  B:  right [L_col_root, R_col_root]  (creates the 2 columns for rows 2+)
  L_col: down-chain [TTF, TTFT, ...]  (left column, rows 2..r)
  R_col: down-chain [TTT, TTTT, ...]  (right column, rows 2..r)

Node encoding:
  {"type": "pane", "pane_id": "..."}
  {"type": "split", "direction": "right"|"down", "ratio": <float>,
   "first": <node>, "second": <node>}

Path arrays use booleans where True = second child and False = first child
(matching herdr's layout.set_split_ratio semantics, validated 0.7.5).

Growth policy (even-completion):
  k=1: split anchor RIGHT 0.5
  k=2: split S1 (right of anchor) DOWN 0.5; S1 ratio 0.5
  k=3: split R1's second child RIGHT 0.5; rebalance(0, 1)
  k=4: split B (bottom of S1) RIGHT 0.5; rebalance(1, 1)
  odd  k>=5: split L_col[-1] DOWN (left column gains a cell)
  even k>=6: split R_col[-1] DOWN (right column gains a cell; row completes)
  after every k>=3 step: rebalance(len(L), len(R))

Usage from bash:
  python3 grid.py <anchor-pane-id>

The script prints the new pane id as JSON on stdout:
  {"pane_id": "w1:pAB"}

Environment variables:
  HERDR_SOCKET_PATH  Path to the herdr Unix socket (default:
                     $XDG_CONFIG_HOME/herdr/herdr.sock or
                     ~/.config/herdr/herdr.sock)
  HERDR_SOCKET_PORT  Port for TCP mock socket (tests only).
"""
from __future__ import annotations

import json
import os
import socket
import sys
from pathlib import Path
from typing import Any

SOCKET_TIMEOUT = 5  # seconds

# ---------------------------------------------------------------------------
# Socket RPC client
# ---------------------------------------------------------------------------

def _socket_path() -> str:
    """Resolve the herdr socket path."""
    env = os.environ.get("HERDR_SOCKET_PATH")
    if env:
        return env
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        candidate = Path(xdg) / "herdr" / "herdr.sock"
        if candidate.exists():
            return str(candidate)
    home = Path.home() / ".config" / "herdr" / "herdr.sock"
    if home.exists():
        return str(home)
    return str(home)  # may not exist; caller handles error


def rpc(method: str, params: dict[str, Any], timeout: float = SOCKET_TIMEOUT) -> dict:
    """Send a JSON-RPC request over the herdr socket.

    Frames are newline-delimited: request ends with \\n, response ends with \\n.
    Uses a TCP connection to 127.0.0.1 when HERDR_SOCKET_PORT is set (tests),
    otherwise a Unix socket at HERDR_SOCKET_PATH (or the default location).

    Raises OSError / ValueError on socket or protocol failure.
    """
    port = os.environ.get("HERDR_SOCKET_PORT")
    if port:
        host = "127.0.0.1"
        port_int = int(port)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    else:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock_path = _socket_path()

    s.settimeout(timeout)
    try:
        if port:
            s.connect((host, port_int))
        else:
            s.connect(sock_path)
        payload = json.dumps({"id": "grid-1", "method": method, "params": params})
        s.sendall(payload.encode() + b"\n")
        data = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
            if b"\n" in data:
                break
        if not data:
            raise OSError(f"no response from herdr for {method}")
        resp = json.loads(data.decode())
        if "error" in resp and resp["error"] is not None:
            raise RuntimeError(f"herdr RPC error for {method}: {resp['error']}")
        return resp
    finally:
        s.close()


def get_layout(pane_id: str, timeout: float = SOCKET_TIMEOUT) -> dict:
    """Fetch the layout tree for *pane_id* via layout.export RPC.

    Returns the layout_export result: {"workspace_id", "tab_id", "zoomed",
    "focused_pane_id", "root": <LayoutNode>}.
    """
    resp = rpc("layout.export", {"pane_id": pane_id}, timeout=timeout)
    result = resp.get("result", {})
    layout = result.get("layout", {})
    return layout


# ---------------------------------------------------------------------------
# Layout parsing
# ---------------------------------------------------------------------------

def parse_layout(layout: dict) -> tuple[str, dict | None]:
    """Parse a layout.export snapshot into (tab_id, root_node).

    The root node is the recursive LayoutNode tree (pane or split), or None
    when the snapshot has no root.
    """
    tab_id = layout.get("tab_id", "")
    root = layout.get("root")
    if root is None:
        # Some export shapes carry the root under a different key; try
        # "layout.root" nested form or a flat panes list fallback.
        root = layout.get("layout", {}).get("root") if isinstance(layout.get("layout"), dict) else None
    return tab_id, root


def _collect_down_chain(node: dict) -> list[str]:
    """Collect the pane ids of a down-chain, walking first-child splits.

    A chain is a list of panes stacked vertically: the chain root is a pane
    whose down-split second child holds the next pane, etc. The walk follows
    the FIRST child of each down-split (each split's first child is a pane).
    """
    chain: list[str] = []
    cur = node
    while cur is not None:
        if cur.get("type") == "pane":
            chain.append(cur.get("pane_id", ""))
            break
        # A split whose first child is a pane and second child continues the chain
        first = cur.get("first")
        second = cur.get("second")
        if isinstance(first, dict) and first.get("type") == "pane":
            chain.append(first.get("pane_id", ""))
            cur = second
        else:
            # Not a recognised down-chain; keep the pane ids found so far
            break
    return chain


def parse_grid_tree(tree: dict) -> dict:
    """Classify a layout.export tree into a grid state.

    Returns a dict with:
      - tab_id: str
      - anchor: str (left-most pane, never split)
      - l_col: list[str]  (left column chain, rows 2+)
      - r_col: list[str]  (right column chain, rows 2+)
      - k: int            (0 = fresh, else the total pane count added)
      - is_fresh: bool
    """
    root = tree.get("root")
    if not isinstance(root, dict):
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": "", "l_col": [], "r_col": [], "k": 0, "is_fresh": True}

    def _pane_id(node: dict) -> str:
        return node.get("pane_id", "")

    if root.get("type") == "pane":
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": _pane_id(root), "l_col": [], "r_col": [], "k": 0, "is_fresh": True}

    # root must be a right split [anchor, S1]
    if root.get("type") != "split" or root.get("direction") != "right":
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": _pane_id(root.get("first", {})), "l_col": [], "r_col": [], "k": 0, "is_fresh": True}

    anchor = _pane_id(root.get("first", {}))
    # If the first child is not a pane (e.g. a nested split from panes added
    # by pre-grid code, or any other unrecognised shape), there is no anchor
    # to grow from — treat the layout as unrecognised so the caller falls
    # back to a fresh right-split of the current pane.
    if not anchor:
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": "", "l_col": [], "r_col": [], "k": 0, "is_fresh": True}
    s1 = root.get("second")
    if not isinstance(s1, dict):
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": anchor, "l_col": [], "r_col": [], "k": 0, "is_fresh": True}

    if s1.get("type") == "pane":
        # k=1: root:right [anchor, S1-pane]
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": anchor, "l_col": [], "r_col": [], "k": 1, "is_fresh": False}

    if s1.get("type") != "split" or s1.get("direction") != "down":
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": anchor, "l_col": [], "r_col": [], "k": 0, "is_fresh": True}

    r1 = s1.get("first")
    b = s1.get("second")

    if not isinstance(r1, dict) or r1.get("type") != "split":
        # k=2: S1:down [R1-pane, B-pane] — row 1 not formed yet
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": anchor, "l_col": [], "r_col": [], "k": 2, "is_fresh": False}

    if not isinstance(b, dict) or b.get("type") == "pane":
        # k=3: S1:down [R1:right [a,b], B-pane] — row 1 formed, columns not yet
        return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": anchor, "l_col": [], "r_col": [], "k": 3, "is_fresh": False}

    # k>=4: B:right [L_col_root, R_col_root]
    # k = 2 + len(L_col) + len(R_col) matches the reference sequence:
    #   k=4: L=[1], R=[1]            (2x2 grid)
    #   k=5: L=[2], R=[1]            (odd k: left grew)
    #   k=6: L=[2], R=[2]            (even k: row completed)
    #   ...
    #   k=12: L=[6], R=[6]           (6x2 grid)
    l_col = _collect_down_chain(b.get("first", {}))
    r_col = _collect_down_chain(b.get("second", {}))
    k = 2 + len(l_col) + len(r_col)
    return {"tab_id": tree.get("tab_id", ""), "root": root, "anchor": anchor, "l_col": l_col, "r_col": r_col, "k": k, "is_fresh": False}


def detect_grid_state(pane_id: str) -> dict:
    """Detect the current grid state from the live layout.

    Returns the parse_grid_tree dict (tab_id, anchor, l_col, r_col, k, is_fresh).
    """
    layout = get_layout(pane_id)
    tree = {"tab_id": layout.get("tab_id", ""), "root": layout.get("root")}
    return parse_grid_tree(tree)


# ---------------------------------------------------------------------------
# Rebalance
# ---------------------------------------------------------------------------

def compute_rebalance_ratios(n_left: int, n_right: int) -> dict[str, float]:
    """Compute the split ratios for rebalancing an even-completion grid.

    Args:
      n_left: number of cells in the left column chain (rows 2+)
      n_right: number of cells in the right column chain (rows 2+)

    Returns:
      A dict with keys:
        - S1_ratio: ratio for the top-level down split (S1)
        - R1_ratio: ratio for the row-1 right split (always 0.5)
        - B_ratio: ratio for the column-creating right split (always 0.5)
        - L_col_{j}_ratio: ratio for left chain cell j (j = 0..n_left-2)
        - R_col_{j}_ratio: ratio for right chain cell j (j = 0..n_right-2)

    The row bands are defined by the LONGER chain. The shorter chain uses
    the same denominators so its last cell goes tall at odd k. Chain cells
    are emitted for range(n-1): the last cell of a chain is a leaf and takes
    the remainder.
    """
    base = max(n_left, n_right)
    ratios: dict[str, float] = {}

    # S1: top-level down split — anchor keeps 1/(1+base) of the right half
    ratios["S1_ratio"] = 1.0 / (1 + base)

    # R1: row-1 right split — always 50%
    ratios["R1_ratio"] = 0.5

    # B: column-creating right split — always 50% (when both columns exist)
    if n_left >= 1 and n_right >= 1:
        ratios["B_ratio"] = 0.5

    # Left column chain: each cell gets 1/(base - j); last cell is a leaf
    for j in range(n_left - 1):
        ratios[f"L_col_{j}_ratio"] = 1.0 / (base - j)

    # Right column chain: uses same base as the longer chain
    for j in range(n_right - 1):
        ratios[f"R_col_{j}_ratio"] = 1.0 / (base - j)

    return ratios


def rebalance(tab_id: str, l_col: list[str], r_col: list[str]) -> None:
    """Rebalance the grid by setting split ratios for all chains.

    Emits layout.set_split_ratio RPC calls for S1, R1, B (when both columns
    exist) and each chain cell, using boolean path arrays (True = first child).

    Paths:
      S1:            [True]
      R1:            [True, False]
      B:             [True, True]
      L_col cell j:  [True, True, False] + [True]*j
      R_col cell j:  [True, True, True] + [True]*j
    """
    n_left = len(l_col)
    n_right = len(r_col)
    ratios = compute_rebalance_ratios(n_left, n_right)

    def set_ratio(path: list[bool], ratio: float) -> None:
        rpc("layout.set_split_ratio", {"tab_id": tab_id, "path": path, "ratio": ratio})

    set_ratio([True], ratios["S1_ratio"])
    set_ratio([True, False], ratios["R1_ratio"])
    if "B_ratio" in ratios:
        set_ratio([True, True], ratios["B_ratio"])
    for j, ratio in ratios.items():
        if j.startswith("L_col_"):
            idx = int(j.removeprefix("L_col_").removesuffix("_ratio"))
            set_ratio([True, True, False] + [True] * idx, ratio)
        elif j.startswith("R_col_"):
            idx = int(j.removeprefix("R_col_").removesuffix("_ratio"))
            set_ratio([True, True, True] + [True] * idx, ratio)


# ---------------------------------------------------------------------------
# GridBuilder — grow the grid by one pane
# ---------------------------------------------------------------------------

class GridBuilder:
    """Grow an even-completion grid of panes to the right of an anchor.

    The builder is stateless: each add_pane() call fetches the live layout
    tree via layout.export, classifies the current k-state, and applies
    exactly ONE growth step plus the rebalance.

    Usage:
        builder = GridBuilder("w1:p80")
        new_pane_id = builder.add_pane()
    """

    def __init__(self, anchor_pane_id: str):
        self.anchor = anchor_pane_id

    def _split(self, target: str, direction: str, ratio: float) -> str:
        resp = rpc("pane.split", {
            "target_pane_id": target,
            "direction": direction,
            "ratio": ratio,
            "focus": False,
        })
        result = resp.get("result", {})
        pane = result.get("pane", {})
        return pane.get("pane_id", "")

    def add_pane(self) -> str:
        """Add one pane to the grid, growing it by the even-completion policy.

        Returns:
            The pane_id of the newly created pane.
        """
        layout = get_layout(self.anchor)
        tab_id = layout.get("tab_id", "")
        state = parse_grid_tree({"tab_id": tab_id, "root": layout.get("root")})

        if state["is_fresh"]:
            # Fresh grid: root is a single pane (the anchor) or unrecognisable.
            # Fall back to starting a fresh grid: split the anchor right.
            target = state["anchor"] or self.anchor
            return self._split(target, "right", 0.5)

        k = state["k"]

        if k == 1:
            # Split S1 (the pane right of the anchor) DOWN; S1 ratio 0.5
            # S1 pane is at path [True] (root.second)
            target = self._pane_at_path(state["root"], [True])
            new_pane = self._split(target, "down", 0.5)
            rpc("layout.set_split_ratio", {"tab_id": tab_id, "path": [True], "ratio": 0.5})
            return new_pane

        if k == 2:
            # At k=2 the tree is S1:down [R1-pane, B-pane]. Reference step k=3:
            # split R1 (first child of the S1 down-split) RIGHT 0.5 → row 1
            # pair, then rebalance(0, 1): S1 + R1 (B only once both columns
            # exist, which happens at the next step).
            target = self._pane_at_path(state["root"], [True, False])
            new_pane = self._split(target, "right", 0.5)
            bottom = self._pane_at_path(state["root"], [True, True])
            rebalance(tab_id, [], [bottom])
            return new_pane

        if k == 3:
            # Split the bottom pane of S1 (B, second child of the down-split)
            # RIGHT 0.5 → starts the 2-column grid (creates L_col + R_col).
            target = self._pane_at_path(state["root"], [True, True])
            new_pane = self._split(target, "right", 0.5)
            l_col = [target]
            r_col = [new_pane]
            rebalance(tab_id, l_col, r_col)
            return new_pane

        # k >= 4: B:right [L_col, R_col]
        l_col = state["l_col"]
        r_col = state["r_col"]

        # Parity rule (reference): the NEXT k decides the column to grow.
        # k_next = k + 1; odd → grow L_col, even → grow R_col.
        if (k + 1) % 2 == 1:
            target = l_col[-1]
            new_pane = self._split(target, "down", 0.5)
            l_col = l_col + [new_pane]
        else:
            target = r_col[-1]
            new_pane = self._split(target, "down", 0.5)
            r_col = r_col + [new_pane]

        rebalance(tab_id, l_col, r_col)
        return new_pane

    def _pane_at_path(self, root: dict | None, path: list[bool]) -> str:
        """Walk the tree from root following boolean path (True = second child)."""
        node = root
        for step in path:
            if not isinstance(node, dict) or node.get("type") != "split":
                return ""
            node = node.get("second") if step else node.get("first")
        if isinstance(node, dict):
            return node.get("pane_id", "")
        return ""


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """CLI entry point: grow the grid by one pane.

    Usage:
        python3 grid.py <anchor-pane-id>

    Prints the new pane id as JSON on stdout.
    """
    if len(sys.argv) < 2:
        print("Usage: grid.py <anchor-pane-id>", file=sys.stderr)
        sys.exit(1)

    anchor = sys.argv[1]
    builder = GridBuilder(anchor)
    try:
        new_pane_id = builder.add_pane()
        if not new_pane_id:
            print("Error: herdr did not return a new pane id", file=sys.stderr)
            sys.exit(1)
        print(json.dumps({"pane_id": new_pane_id}))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
