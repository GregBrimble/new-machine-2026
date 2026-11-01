"""Host-side input for the disposable test VM. No host UI permissions required."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib.parse import urlparse


def normalized(text):
    return re.sub(r"\s+", " ", text.translate(str.maketrans("‘’“”", "''\"\""))).strip().lower()


class UI:
    def __init__(self, endpoint, ocr, results):
        url = urlparse(endpoint)
        if url.scheme != "vnc" or url.hostname != "127.0.0.1" or not url.port or not url.password:
            raise ValueError("Expected Tart's authenticated loopback VNC endpoint")
        self.endpoint = url
        self.connect()
        self.ocr = ocr
        self.results = Path(results)
        self.rows = []

    def connect(self):
        from vncdotool import api
        self.client = api.connect(f"127.0.0.1::{self.endpoint.port}", password=self.endpoint.password, timeout=60)
        self.client.factory.force_caps = True

    def capture(self):
        image = self.results / "ui-latest.png"
        try:
            self.client.captureScreen(str(image))
        except TimeoutError:
            print("Reconnecting the guest VNC display after a timeout", flush=True)
            self.client.disconnect()
            self.connect()
            self.client.captureScreen(str(image))
        result = subprocess.run([self.ocr, str(image)], capture_output=True, text=True, timeout=20, check=True)
        self.rows = json.loads(result.stdout)
        (self.results / "ui-latest.json").write_text(json.dumps(self.rows, indent=2))
        return self.rows

    def find(self, label):
        return next((row for row in self.rows if normalized(row["text"]) == normalized(label)), None)

    def click(self, row):
        self.client.mouseMove(round(row["x"] + row["width"] / 2), round(row["y"] + row["height"] / 2))
        self.client.mousePress(1)

    def text(self, text):
        for char in text:
            self.key(char)

    def key(self, key):
        # Virtualization.Framework's VNC server maps X11 Alt to macOS Command.
        # Give the virtual keyboard distinct down/up events rather than sending
        # both in the same TCP packet (which can leave a key repeating).
        self.client.keyDown(key)
        time.sleep(.04)
        self.client.keyUp(key)
        time.sleep(.02)

    def remember(self, name):
        shutil.copyfile(self.results / "ui-latest.png", self.results / f"ui-{name}.png")

    def close(self):
        from vncdotool import api
        self.client.disconnect()
        api.shutdown()


def permission_button(rows):
    text = normalized(" ".join(row["text"] for row in rows))
    terminal_control = ('"terminal" wants access to control' in text or
                        '"terminal" would like to control' in text)
    target = '"system events"' in text or '"system settings"' in text
    downloads = ("would like to access files in your downloads folder" in text and
                 any(f'"{name}"' in text for name in ("terminal", "downloads-cleanup", "find")))
    if (terminal_control and target) or downloads:
        return next((row for row in rows if normalized(row["text"]) in ("allow", "ok")), None)
    return None


def accessibility_switch(image_path, row):
    from PIL import Image
    image = Image.open(image_path).convert("RGB")
    y = round(row["y"] + row["height"] / 2)
    # Light appearance uses a white thumb; dark appearance uses light gray.
    for threshold in (251, 210):
        start = None
        for x in range(round(row["x"] + row["width"]), image.width):
            light = min(image.getpixel((x, y))) > threshold
            if light and start is None:
                start = x
            if not light and start is not None:
                if row["height"] * .6 < x - start < row["height"] * 2.5:
                    return {"x": start, "y": y - 1, "width": x - start, "height": 2}
                start = None
    raise RuntimeError("Could not locate the Accessibility switch beside Terminal")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--ocr", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--stage", choices=("first", "after-login"), required=True)
    args = parser.parse_args()
    ui = UI(args.endpoint, args.ocr, args.results)
    try:
        drive(ui, args.stage)
    except Exception:
        if (ui.results / "ui-latest.png").exists():
            ui.remember("failure")
        raise
    finally:
        ui.close()


def drive(ui, stage):
    deadline = time.monotonic() + 5400
    started = stage == "after-login"
    startup_deadline = time.monotonic() + 600
    toggled = False
    authenticated = False
    desktop_ready = False
    while time.monotonic() < deadline:
        status_file = ui.results / "status"
        status = status_file.read_text().strip() if status_file.exists() else ""
        if status == "failed":
            ui.capture()
            raise RuntimeError("Guest test failed; inspect guest logs and ui-latest.png")
        if status == ("reboot-required" if stage == "first" else "passed"):
            return
        if not started and (ui.results / "guest-first.log").exists():
            started = True
            print("Started the guest test in Terminal", flush=True)
        if not started and time.monotonic() > startup_deadline:
            raise TimeoutError("The guest test did not start in Terminal within ten minutes")
        ui.capture()
        text = normalized(" ".join(row["text"] for row in ui.rows))
        if not desktop_ready and ui.rows:
            # Reconnect after the boot display changes size; discard the old
            # framebuffer before using screenshot coordinates for input.
            ui.client.disconnect()
            ui.connect()
            desktop_ready = True
            continue
        button = permission_button(ui.rows)
        if button:
            ui.remember(f"consent-{int(time.time())}")
            ui.click(button)
            print("Approved the expected guest privacy prompt", flush=True)
        elif ui.find("Don't Allow"):
            raise RuntimeError(f"Unexpected guest privacy prompt: {text}")
        elif not toggled and "allow the applications below to control your computer" in text:
            # This row is enabled by the VM's virtual mouse, before AX access exists.
            terminal = next((row for row in ui.rows if normalized(row["text"]) == "terminal" and row["y"] > 100), None)
            if terminal and "accessibility" in text:
                ui.click(accessibility_switch(ui.results / "ui-latest.png", terminal))
                toggled = True
                print("Enabled Terminal Accessibility in the guest", flush=True)
        elif toggled and not authenticated and "privacy & security is trying to" in text and ui.find("Modify Settings"):
            # Credentials belong only to the disposable Cirrus Labs test image.
            ui.text("admin")
            ui.key("enter")
            authenticated = True
        time.sleep(1)
    raise TimeoutError("VM UI test timed out after 90 minutes")


if __name__ == "__main__":
    main()
