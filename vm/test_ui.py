import unittest
from types import SimpleNamespace
from unittest.mock import patch
from ui import accessibility_switch, normalized, permission_button


def rows(*labels):
    return [{"text": text} for text in labels]


class PrivacyPrompts(unittest.TestCase):
    def test_expected_terminal_automation(self):
        for target in ("System Events", "System Settings"):
            prompt = rows(f'“Terminal” wants access to control “{target}”.', "Don’t Allow", "Allow")
            self.assertIs(permission_button(prompt), prompt[-1])

    def test_expected_downloads_access(self):
        for app in ("Terminal", "downloads-cleanup", "find"):
            prompt = rows(f'“{app}” would like to access files in your Downloads folder.', "Don’t Allow", "OK")
            self.assertIs(permission_button(prompt), prompt[-1])

    def test_unrelated_permissions_are_not_approved(self):
        for caption in (
            '“Other App” wants access to control “System Events”.',
            '“Terminal” wants access to control “Safari”.',
            '“Terminal” would like to access your microphone.',
            '“Other App” would like to access files in your Downloads folder.',
            'Would you like to install an update?',
        ):
            self.assertIsNone(permission_button(rows(caption, "Don’t Allow", "Allow", "OK")))

    def test_accessibility_switch_in_light_and_dark_appearance(self):
        for background, thumb in ((240, 255), (35, 226)):
            class Screenshot:
                width = 120
                def convert(self, mode):
                    return self
                def getpixel(self, point):
                    x, _ = point
                    shade = thumb if 80 <= x < 100 else 100 if 70 <= x < 110 else background
                    return (shade,) * 3
            pillow = SimpleNamespace(Image=SimpleNamespace(open=lambda _: Screenshot()))
            with patch.dict("sys.modules", {"PIL": pillow}):
                switch = accessibility_switch("guest.png", {"x": 10, "y": 30, "width": 10, "height": 20})
            self.assertEqual(switch, {"x": 80, "y": 39, "width": 20, "height": 2})

    def test_smart_quotes_and_wrapped_captions(self):
        self.assertEqual(normalized('“Terminal”\nwants access'), '"terminal" wants access')


if __name__ == "__main__":
    unittest.main()
