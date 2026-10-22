"""Watches Vilausity's conversations through its local API (docs/local-api.md) and says when
Claude waits for you or has finished a turn: a line here and a beep.

    python notify.py

Turn the local API on first (Settings > Local API). Standard library only.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

API_FILE = os.path.expandvars(r"%APPDATA%\Vilausity\api.json")
# Not through the system's proxy: a proxy program may not pass 127.0.0.1 on.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def events():
    """Yields (name, data) from the event stream until it ends."""
    with open(API_FILE, encoding="utf-8") as file:
        api = json.load(file)
    request = urllib.request.Request(api["url"] + "/events", headers={"Authorization": "Bearer " + api["token"]})
    with opener.open(request) as stream:
        name = None
        for raw in stream:
            line = raw.decode("utf-8").rstrip("\r\n")
            if line.startswith("event: "):
                name = line[len("event: ") :]
            elif line.startswith("data: ") and name:
                yield name, json.loads(line[len("data: ") :])
            elif line == "":
                name = None


def beep():
    try:
        import winsound

        winsound.MessageBeep()
    except ImportError:
        print("\a", end="", flush=True)


def main():
    while True:
        try:
            print("connected; waiting for events", file=sys.stderr)
            for name, data in events():
                if name != "conversation.state":
                    continue
                title = data["title"] or "(new conversation)"
                stamp = time.strftime("%H:%M:%S")
                if data["state"] == "waiting":
                    print(f"{stamp}  Claude is waiting for you: {title}")
                    beep()
                elif data["state"] == "idle" and data.get("previous") == "running":
                    print(f"{stamp}  done: {title}")
                    beep()
        except (OSError, urllib.error.URLError, ValueError) as error:
            # Vilausity closed, the API turned off, api.json not there yet.
            print(f"not connected ({error}); trying again in 5 s", file=sys.stderr)
            time.sleep(5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
