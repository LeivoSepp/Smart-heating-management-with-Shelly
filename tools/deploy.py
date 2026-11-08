#!/usr/bin/env python3
"""Upload the script to a Shelly device over its HTTP RPC and inspect the device.

    python3 tools/deploy.py main <ip> [script id]      strip comments, convert to ASCII, upload in chunks, read back, start (creates the script if missing)
    python3 tools/deploy.py watchdog <ip> [script id]  upload files/watchdog-min.js the same way
    python3 tools/deploy.py verify <ip>                script status, relay timer, KVS values and schedules
    python3 tools/deploy.py kvs <ip> <key> <value>     set a KVS value (the JSON value as one argument)
    python3 tools/deploy.py log <ip> [seconds]         print the device's debug log (prints and script errors)

Script.GetCode and Script.PutCode are called with 1 kB chunks: a whole-script call has rebooted a Plus 1PM.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 1024
REPLACEMENTS = {"’": "'", "→": "->", "°": "deg", "€": "EUR", "–": "-", "õ": "o", "ā": "a", "ī": "i"}


def rpc(ip, method, params=None):
    body = json.dumps({"id": 1, "method": method, "params": params or {}}).encode()
    request = urllib.request.Request(f"http://{ip}/rpc/", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        answer = json.loads(response.read())
    if "error" in answer:
        raise SystemExit(f"{method}: {answer['error']}")
    return answer.get("result")


def device_copy(source):
    text = source
    for char, replacement in REPLACEMENTS.items():
        text = text.replace(char, replacement)
    out = []
    i = 0
    quote = None
    while i < len(text):
        char = text[i]
        if quote is None and text.startswith("//", i):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
            continue
        if quote is None and text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = len(text) if end < 0 else end + 2
            continue
        out.append(char)
        if quote is None and char in "'\"`":
            quote = char
        elif quote is not None and char == "\\":
            out.append(text[i + 1])
            i += 1
        elif quote is not None and char == quote:
            quote = None
        i += 1
    lines = [line.rstrip() for line in "".join(out).split("\n") if line.strip()]
    stripped = "\n".join(lines) + "\n"
    bad = sorted({c for c in stripped if ord(c) > 127})
    if bad:
        raise SystemExit(f"non-ASCII characters left, add them to REPLACEMENTS: {bad}")
    return stripped


def read_code(ip, script_id):
    code = ""
    while True:
        part = rpc(ip, "Script.GetCode", {"id": script_id, "offset": len(code), "len": 2 * CHUNK})
        code += part["data"]
        if part["left"] == 0:
            return code


def ensure_script(ip, script_id, name):
    if any(script["id"] == script_id for script in rpc(ip, "Script.List")["scripts"]):
        return
    created = rpc(ip, "Script.Create", {"name": name})
    if created["id"] != script_id:
        raise SystemExit(f"the device created script {created['id']} instead of {script_id}, pass that id")
    rpc(ip, "Script.SetConfig", {"id": script_id, "config": {"enable": True}})
    print(f"script {script_id}: created as '{name}' with autostart")


def upload(ip, script_id, code):
    ensure_script(ip, script_id, "Smart Heating" if script_id == 1 else "watchdog")
    print(f"script {script_id}: stop ->", rpc(ip, "Script.Stop", {"id": script_id}))
    for offset in range(0, len(code), CHUNK):
        rpc(ip, "Script.PutCode", {"id": script_id, "code": code[offset:offset + CHUNK], "append": offset > 0})
    if read_code(ip, script_id) != code:
        raise SystemExit("the code read back differs from the upload, the script is NOT started")
    print(f"script {script_id}: {len(code)} characters uploaded and read back")
    print(f"script {script_id}: start ->", rpc(ip, "Script.Start", {"id": script_id}))


def verify(ip):
    print("sys:", {key: rpc(ip, "Sys.GetStatus").get(key) for key in ("time", "uptime", "ram_free")})
    for script in rpc(ip, "Script.List")["scripts"]:
        print("script", script["id"], script["name"], rpc(ip, "Script.GetStatus", {"id": script["id"]}))
    print("relay timer:", {key: value for key, value in rpc(ip, "Switch.GetConfig", {"id": 0}).items() if "auto_" in key})
    for item in rpc(ip, "KVS.GetMany")["items"]:
        print("kvs", item["key"], item["value"])
    print("schedules:", [(job["id"], job["timespec"], job["calls"][0]["method"]) for job in rpc(ip, "Schedule.List")["jobs"]])


def debug_log(ip, seconds):
    import asyncio
    import aiohttp

    async def capture():
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(f"ws://{ip}/debug/log", timeout=10) as socket:
                end = time.time() + seconds
                while time.time() < end:
                    try:
                        message = await asyncio.wait_for(socket.receive(), timeout=max(0.1, end - time.time()))
                    except asyncio.TimeoutError:
                        return
                    if message.type == aiohttp.WSMsgType.TEXT:
                        try:
                            print(json.loads(message.data).get("data", message.data).rstrip())
                        except ValueError:
                            print(message.data.rstrip())
                    elif message.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        return

    asyncio.run(capture())


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    command, ip = argv[1], argv[2]
    if command == "main":
        upload(ip, int(argv[3]) if len(argv) > 3 else 1, device_copy((ROOT / "SmartHeatingWidthShelly.js").read_text(encoding="utf-8")))
    elif command == "watchdog":
        upload(ip, int(argv[3]) if len(argv) > 3 else 2, (ROOT / "files" / "watchdog-min.js").read_text(encoding="utf-8"))
    elif command == "verify":
        verify(ip)
    elif command == "kvs":
        print(rpc(ip, "KVS.Set", {"key": argv[3], "value": argv[4]}))
    elif command == "log":
        debug_log(ip, int(argv[3]) if len(argv) > 3 else 60)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
