"""Turning stickers upright by reading their text."""

import pytest
from PIL import Image, ImageDraw, ImageFont
from stickersplit.orient import detect


def text_sticker(lines=("PRIVACY IS", "A HUMAN RIGHT"), size=72) -> Image.Image:
    """An upright, landscape sticker with dark text on white, on a transparent margin."""
    font = ImageFont.load_default(size=size)
    im = Image.new("RGBA", (900, 140 + 100 * len(lines)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((20, 20, im.width - 20, im.height - 20), 30, fill="white")
    for k, line in enumerate(lines):
        d.text((70, 70 + 100 * k), line, fill="black", font=font)
    return im


@pytest.mark.parametrize("scanned", [0, 90, 180, 270])
def test_text_finds_the_way_up(scanned):
    im = text_sticker().rotate(-scanned, expand=True)  # as it lay on the scanner
    o = detect(im)
    assert o.confident and (scanned + o.turn) % 360 == 0
    assert "HUMAN" in o.text


def test_no_text_is_left_as_scanned():
    im = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse((20, 20, 380, 280), fill=(200, 30, 30, 255))
    o = detect(im)
    assert not o.confident and o.turn == 0
