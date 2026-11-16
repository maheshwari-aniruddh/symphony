"""
Symphony jam session server: real-time multiplayer "Band Mode".
- POST /create_room            new 6-character room code
- GET  /check_room/{room_id}   does it exist, how many players, is it full
- GET  /health                 liveness probe
- WS   /ws/{room_id}/{player_id}   join a room; relays each player's notes to the
                                   others and keeps everyone's roster up to date
                                   (message shapes are documented on websocket_join)

The site reaches this server same-origin through the dev/preview proxy at /jam
(see vite.config.js), so one port or one HTTPS tunnel serves everything.
"""
import asyncio
import inspect
import json
import random
import string
import time
from typing import Dict, Set, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
import os
import httpx
import websockets as ws_client

# HTTPX client for proxying backend requests (Music API and Streamlit)
client = httpx.AsyncClient()


def _ws_headers_kwarg() -> str:
    """Name of the request-headers kwarg accepted by this `websockets` version.

    websockets >= 14 renamed the client's ``extra_headers`` to ``additional_headers``
    (the old name then fails with a TypeError when the connection is opened).
    """
    try:
        params = inspect.signature(ws_client.connect).parameters
    except (TypeError, ValueError):
        return "extra_headers"
    return "additional_headers" if "additional_headers" in params else "extra_headers"


_WS_HEADERS_KWARG = _ws_headers_kwarg()


def _connect_upstream_ws(url: str, headers: list):
    """Open the upstream Streamlit WebSocket on any `websockets` version."""
    return ws_client.connect(url, subprotocols=["streamlit"], **{_WS_HEADERS_KWARG: headers})

app = FastAPI(title="AirJam Session Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


MAX_PLAYERS_PER_ROOM = 8
INSTRUMENTS = {"piano", "bass", "drums"}
MAX_MESSAGE_CHARS = 2048


def _clean_instrument(value: Any) -> str:
    """Only the instruments the players can actually voice; anything else is 'piano'."""
    value = str(value or "").strip().lower()
    return value if value in INSTRUMENTS else "piano"


class ConnectionManager:
    """In-memory jam rooms.

    rooms: room_id -> {WebSocket: {"player_id": str, "instrument": str | None}}
    A player's instrument is None until their "join" message arrives.
    Players are tracked per connection (not per id), so two tabs that somehow share
    an id still hear each other and are removed independently.
    """

    def __init__(self):
        self.rooms: Dict[str, Dict[WebSocket, dict]] = {}
        self.created_rooms: Set[str] = set()  # codes handed out by /create_room (may have no players yet)

    def _normalize_room_id(self, room_id: str) -> str:
        return (room_id or "").strip().upper()

    def exists(self, room_id: str) -> bool:
        room_id = self._normalize_room_id(room_id)
        return room_id in self.rooms or room_id in self.created_rooms

    def count(self, room_id: str) -> int:
        return len(self.rooms.get(self._normalize_room_id(room_id), {}))

    def is_full(self, room_id: str) -> bool:
        return self.count(room_id) >= MAX_PLAYERS_PER_ROOM

    def roster(self, room_id: str) -> list:
        """Everyone currently connected to the room, in join order."""
        room = self.rooms.get(self._normalize_room_id(room_id), {})
        return [{"player_id": p["player_id"], "instrument": p["instrument"]} for p in room.values()]

    def add(self, room_id: str, websocket: WebSocket, player_id: str) -> None:
        room_id = self._normalize_room_id(room_id)
        if not room_id:
            return
        self.rooms.setdefault(room_id, {})[websocket] = {"player_id": player_id, "instrument": None}

    async def announce(self, room_id: str, websocket: WebSocket, instrument: str) -> None:
        """A player said what they are playing: tell the others, then send everyone the roster."""
        room_id = self._normalize_room_id(room_id)
        player = self.rooms.get(room_id, {}).get(websocket)
        if player is None:
            return
        first_time = player["instrument"] is None
        player["instrument"] = instrument
        if first_time:
            await self.broadcast(room_id, {
                "type": "player_joined",
                "player_id": player["player_id"],
                "instrument": instrument,
                "ts": time.time(),
            }, exclude=websocket)
        await self.broadcast_roster(room_id)

    async def remove(self, room_id: str, websocket: WebSocket) -> None:
        room_id = self._normalize_room_id(room_id)
        room = self.rooms.get(room_id)
        if room is None:
            return
        player = room.pop(websocket, None)
        if not room:
            # last one out: drop the room (broadcast() does the same for dead sockets)
            self.rooms.pop(room_id, None)
            return
        if player is not None:
            await self.broadcast(room_id, {
                "type": "player_left",
                "player_id": player["player_id"],
                "instrument": player["instrument"],
                "ts": time.time(),
            })
        await self.broadcast_roster(room_id)

    async def broadcast_roster(self, room_id: str) -> None:
        await self.broadcast(room_id, {"type": "roster", "room_id": room_id, "players": self.roster(room_id)})

    async def broadcast(self, room_id: str, message: dict, exclude: WebSocket = None) -> None:
        """Send to every connection in the room (optionally all but one), pruning dead sockets."""
        room_id = self._normalize_room_id(room_id)
        room = self.rooms.get(room_id)
        if not room:
            return
        dead = []
        for ws in list(room):
            if ws is exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            room.pop(ws, None)
        if room_id in self.rooms and not self.rooms[room_id]:
            del self.rooms[room_id]


manager = ConnectionManager()


def generate_room_id() -> str:
    # No look-alikes (0/O, 1/I, 5/S, 2/Z, 8/B): codes get read aloud and typed on phones.
    return "".join(random.choices("ACDEFGHJKLMNPQRTUVWXY34679", k=6))


@app.get("/health")
async def health():
    """Cheap liveness probe (the studio uses it to tell 'server off' from 'bad code')."""
    return {"ok": True, "rooms": len(manager.rooms)}


@app.post("/create_room")
async def create_room():
    """Generate a new 6-character room code, unique among active rooms."""
    for _ in range(20):
        room_id = generate_room_id()
        if not manager.exists(room_id):
            manager.created_rooms.add(room_id)
            return {"room_id": room_id}
    room_id = generate_room_id()
    manager.created_rooms.add(room_id)
    return {"room_id": room_id}

@app.get("/check_room/{room_id}")
async def check_room(room_id: str):
    """Check if a room exists (and how busy it is) before a player joins."""
    rid = (room_id or "").strip().upper()
    if manager.exists(rid):
        return {"exists": True, "players": manager.count(rid), "full": manager.is_full(rid)}
    return {"exists": False}

@app.websocket("/ws/{room_id}/{player_id}")
async def websocket_join(
    websocket: WebSocket,
    room_id: str,
    player_id: str,
):
    """
    Join a jam room.

    Client -> server
      { "type": "join", "instrument": "piano" | "bass" | "drums" }     once, right after connecting
      { "type": "note", "note": "C4" | "E2" | "kick", "velocity": 0..1 }

    Server -> client
      { "type": "roster", "players": [ { "player_id", "instrument" } ] }   on every join / leave
      { "type": "player_joined" | "player_left", "player_id", "instrument" }
      { "type": "note", "player_id", "instrument", "note", "velocity", "ts" }   other players' notes only
      { "type": "room_full", "max": N }                                    then the socket is closed
    """
    rid = (room_id or "").strip().upper()
    pid = (player_id or "").strip()

    await websocket.accept()

    if not rid or len(rid) > 12 or not pid or len(pid) > 40:
        await websocket.close(code=1008)
        return
    if manager.is_full(rid):
        await websocket.send_json({"type": "room_full", "max": MAX_PLAYERS_PER_ROOM})
        await websocket.close(code=4001)
        return

    manager.add(rid, websocket, pid)
    print(f"[Jam] {pid} connected to {rid} ({manager.count(rid)} in room)")

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_MESSAGE_CHARS:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue

            kind = obj.get("type")
            if kind == "join":
                await manager.announce(rid, websocket, _clean_instrument(obj.get("instrument")))
            elif kind == "note":
                player = manager.rooms.get(rid, {}).get(websocket) or {}
                try:
                    velocity = max(0.0, min(1.0, float(obj.get("velocity", 0.8))))
                except (TypeError, ValueError):
                    velocity = 0.8
                await manager.broadcast(rid, {
                    "type": "note",
                    "room_id": rid,
                    "player_id": pid,  # always the connection's own id, never what the message claims
                    "instrument": _clean_instrument(obj.get("instrument") or player.get("instrument")),
                    "note": str(obj.get("note", ""))[:16],
                    "velocity": velocity,
                    "ts": time.time(),
                }, exclude=websocket)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[Jam] {pid} dropped from {rid}: {e!r}")
    finally:
        await manager.remove(rid, websocket)

# --- Reverse Proxy Routes for Ngrok Support ---
# This proxies frontend requests to the underlying APIs when running via a single ngrok URL

@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def proxy_music_api(path: str, request: Request):
    # Proxy to Music API on 8766
    url = f"http://127.0.0.1:8766/api/{path}"
    headers = dict(request.headers)
    headers.pop("host", None)
    
    # Handle both multipart and JSON bodies
    content = None
    if request.method in ("POST", "PUT", "PATCH"):
        content = await request.body()
    
    req = client.build_request(
        request.method,
        url,
        headers=headers,
        content=content,
        params=request.query_params
    )
    r = await client.send(req, stream=True)
    return StreamingResponse(
        r.aiter_raw(),
        status_code=r.status_code,
        headers=dict(r.headers)
    )

@app.api_route("/streamlit/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def proxy_streamlit(path: str, request: Request):
    # Use the exact requested path to preserve trailing slashes (which prevents Tornado redirect loops)
    url = f"http://127.0.0.1:8768{request.url.path}"
    headers = dict(request.headers)
    
    # Set proper forwarding headers to prevent Streamlit redirect loops
    forwarded_host = headers.get("host", "localhost:8502")
    forwarded_proto = headers.get("x-forwarded-proto", "http")
    if "ngrok" in forwarded_host:
        forwarded_proto = "https"
        
    headers["X-Forwarded-Host"] = forwarded_host
    headers["X-Forwarded-Proto"] = forwarded_proto
    headers["X-Forwarded-For"] = request.client.host if request.client else "127.0.0.1"
    headers.pop("host", None)
    
    print(f"[PROXY DEBUG] incoming path: '{path}' -> target URL: {url} | params: {request.query_params}")
    
    req = client.build_request(
        request.method,
        url,
        headers=headers,
        content=await request.body() if request.method in ("POST", "PUT", "PATCH") else None,
        params=request.query_params
    )
    r = await client.send(req, stream=True)
    return StreamingResponse(
        r.aiter_raw(),
        status_code=r.status_code,
        headers=dict(r.headers)
    )

@app.api_route("/streamlit", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
@app.api_route("/streamlit/", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def proxy_streamlit_root(request: Request):
    return await proxy_streamlit("", request)

# Streamlit internal sub-resource proxy routes
# These are needed because Streamlit's HTML uses relative paths that resolve to the root.
async def _proxy_to_streamlit(path: str, request: Request):
    target_path = f"/{path}" if path and not path.startswith("/") else path
    url = f"http://127.0.0.1:8768/streamlit{target_path}"
    headers = dict(request.headers)
    
    forwarded_host = headers.get("host", "localhost:8502")
    forwarded_proto = headers.get("x-forwarded-proto", "http")
    if "ngrok" in forwarded_host:
        forwarded_proto = "https"
        
    headers["X-Forwarded-Host"] = forwarded_host
    headers["X-Forwarded-Proto"] = forwarded_proto
    headers["X-Forwarded-For"] = request.client.host if request.client else "127.0.0.1"
    headers.pop("host", None)
    req = client.build_request(
        request.method, url, headers=headers,
        content=await request.body() if request.method in ("POST", "PUT", "PATCH") else None,
        params=request.query_params
    )
    r = await client.send(req, stream=True)
    return StreamingResponse(r.aiter_raw(), status_code=r.status_code, headers=dict(r.headers))

@app.api_route("/_stcore/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def proxy_stcore(path: str, request: Request):
    return await _proxy_to_streamlit(f"_stcore/{path}", request)

@app.api_route("/_stapi/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def proxy_stapi(path: str, request: Request):
    return await _proxy_to_streamlit(f"_stapi/{path}", request)

@app.api_route("/stream", methods=["GET", "POST"])
async def proxy_stream(request: Request):
    return await _proxy_to_streamlit("stream", request)

# ---- WebSocket proxy for Streamlit's real-time stream ----
# Streamlit uses /_stcore/stream as a WS endpoint for live data updates.
# We proxy it here so ngrok (single port) can forward it correctly.
@app.websocket("/_stcore/stream")
async def proxy_streamlit_ws(client_ws: WebSocket):
    await client_ws.accept()
    streamlit_ws_url = "ws://127.0.0.1:8768/streamlit/_stcore/stream"
    
    # Forward headers (especially Origin, Cookie, and Streamlit-specific ones)
    headers = []
    for k, v in client_ws.headers.items():
        if k.lower() not in ('host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'):
            headers.append((k, v))
            
    try:
        async with _connect_upstream_ws(streamlit_ws_url, headers) as server_ws:
            async def forward_to_server():
                try:
                    while True:
                        data = await client_ws.receive_bytes()
                        await server_ws.send(data)
                except Exception:
                    pass

            async def forward_to_client():
                try:
                    async for message in server_ws:
                        if isinstance(message, bytes):
                            await client_ws.send_bytes(message)
                        else:
                            await client_ws.send_text(message)
                except Exception:
                    pass

            await asyncio.gather(forward_to_server(), forward_to_client())
    except Exception as e:
        print(f"[WS Proxy] Streamlit WS error: {e}")
    finally:
        try:
            await client_ws.close()
        except Exception:
            pass

# Also proxy the full-path WS that Streamlit uses when baseUrlPath=/streamlit
@app.websocket("/streamlit/_stcore/stream")
async def proxy_streamlit_ws_full(client_ws: WebSocket):
    await client_ws.accept()
    streamlit_ws_url = "ws://127.0.0.1:8768/streamlit/_stcore/stream"
    
    headers = []
    for k, v in client_ws.headers.items():
        if k.lower() not in ('host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'):
            headers.append((k, v))
            
    try:
        async with _connect_upstream_ws(streamlit_ws_url, headers) as server_ws:
            async def fwd_in():
                try:
                    while True:
                        data = await client_ws.receive_bytes()
                        await server_ws.send(data)
                except Exception:
                    pass

            async def fwd_out():
                try:
                    async for message in server_ws:
                        if isinstance(message, bytes):
                            await client_ws.send_bytes(message)
                        else:
                            await client_ws.send_text(message)
                except Exception:
                    pass

            await asyncio.gather(fwd_in(), fwd_out())
    except Exception as e:
        print(f"[WS Proxy /streamlit/_stcore/stream] error: {e}")
    finally:
        try:
            await client_ws.close()
        except Exception:
            pass


# Serve frontend static files
# @app.websocket routes take priority over mounted static files in FastAPI
_root_dir = os.path.dirname(os.path.abspath(__file__))
_frontend_dir = os.path.join(_root_dir, "airplay 2")
_sounds_dir = os.path.join(_root_dir, "sounds")
_drum_sounds_dir = os.path.join(_root_dir, "drum_sounds")

if os.path.isdir(_sounds_dir):
    app.mount("/sounds", StaticFiles(directory=_sounds_dir), name="sounds")

if os.path.isdir(_drum_sounds_dir):
    app.mount("/drum_sounds", StaticFiles(directory=_drum_sounds_dir), name="drum_sounds")

if os.path.isdir(_frontend_dir):
    app.mount("/static", StaticFiles(directory=_frontend_dir, html=True), name="frontend-static")
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8502)
