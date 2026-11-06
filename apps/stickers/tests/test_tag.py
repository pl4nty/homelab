"""Tagger tests. No network: a fake client for logic, and the real anthropic SDK
over a mocked HTTP transport to check the request it actually sends."""

import base64
import io
import json
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image
from stickersplit.core import Options, split_scan
from stickersplit.tag import (
    FINE_SCHEMA,
    PANEL_PX,
    PANELS,
    SCHEMA,
    StickerInfo,
    build_request,
    rotate_image,
    rotate_png,
    rotation_grid,
    symmetry_angle,
    tag_one,
)
from test_split import make_scan


def _reply(**kw):
    body = {"upright_panel": "A", "orientation_confidence": "high", "title": "t", "tags": []}
    body.update(kw)
    return SimpleNamespace(
        stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(body))]
    )


class FakeClient:
    """Answers per sticker by the order requests arrive; records requests."""

    def __init__(self, answers, fine=None):
        self.answers = answers  # detail-image size -> reply or Exception
        self.fine = list(fine or [])  # queued fine-pass panel letters; default "E" (0 deg)
        self.requests = []
        self.messages = self

    def create(self, **req):
        self.requests.append(req)
        if req["output_config"]["format"]["schema"] is FINE_SCHEMA:
            panel = self.fine.pop(0) if self.fine else "E"
            return SimpleNamespace(
                stop_reason="end_turn",
                content=[SimpleNamespace(type="text", text=json.dumps({"panel": panel}))],
            )
        # identify the sticker by the size of the detail image (unique per crop here)
        data = base64.b64decode(req["messages"][0]["content"][0]["source"]["data"])
        size = Image.open(io.BytesIO(data)).size
        a = self.answers[size]
        if isinstance(a, Exception):
            raise a
        return a


def _split(tmp_path):
    out = tmp_path / "out"
    stickers, _ = split_scan(make_scan(tmp_path / "scan.png"), out, Options())
    return out, stickers


def _detail_size(out, s):
    from stickersplit.tag import detail_image

    return detail_image(Image.open(out / s.file)).size


def test_grid_panels_show_their_labelled_rotation():
    im = Image.new("RGB", (200, 100), (0, 0, 255))
    im.paste((255, 0, 0), (0, 0, 200, 30))  # red band along the top edge
    g = np.asarray(rotation_grid(im)).astype(int)
    label_h, gap = 44, 12
    cell = PANEL_PX + gap

    def red_side(i):
        x = gap + (i % 2) * cell
        y = gap + (i // 2) * (cell + label_h) + label_h
        p = g[y : y + PANEL_PX, x : x + PANEL_PX]
        red = (p[..., 0] > 200) & (p[..., 2] < 60)
        ys, xs = np.nonzero(red)
        blue = (p[..., 2] > 200) & (p[..., 0] < 60)
        by, bx = np.nonzero(blue)
        dy, dx = ys.mean() - by.mean(), xs.mean() - bx.mean()
        return (
            ("top" if dy < 0 else "bottom")
            if abs(dy) > abs(dx)
            else ("left" if dx < 0 else "right")
        )

    # A=0, B=90 cw (top->right), C=180 (top->bottom), D=270 cw (top->left)
    assert [red_side(i) for i in range(4)] == ["top", "right", "bottom", "left"]


def test_schema_matches_model_and_subset_rules():
    assert set(SCHEMA["required"]) == set(StickerInfo.model_fields)
    assert SCHEMA["additionalProperties"] is False
    assert SCHEMA["properties"]["upright_panel"]["enum"] == list(PANELS)


def test_request_shape(tmp_path):
    out, stickers = _split(tmp_path)
    req = build_request(Image.open(out / stickers[0].file), "m", "low")
    assert req["output_config"]["effort"] == "low"
    assert req["output_config"]["format"]["schema"] is SCHEMA
    c = req["messages"][0]["content"]
    assert [b["type"] for b in c] == ["image", "image", "text"]  # images before text
    for b in c[:2]:
        im = Image.open(io.BytesIO(base64.b64decode(b["source"]["data"])))
        assert im.format == "JPEG" and max(im.size) <= 1568
    assert (
        "effort"
        not in build_request(Image.open(out / stickers[0].file), "m", None)["output_config"]
    )


def test_tag_one_rotates_and_cleans_tags(tmp_path):
    out, st = _split(tmp_path)
    before = {s.file: np.asarray(Image.open(out / s.file)) for s in st}
    sizes = {s.file: _detail_size(out, s) for s in st}
    assert len(set(sizes.values())) == len(st)
    client = FakeClient(
        {
            sizes[st[0].file]: _reply(
                upright_panel="C", title="Upside", tags=["Holo", "holo ", "CTF"]
            ),
            sizes[st[1].file]: _reply(upright_panel="B", title="Sideways"),
            sizes[st[2].file]: SimpleNamespace(
                stop_reason="end_turn", content=[SimpleNamespace(type="text", text="not json")]
            ),
        }
    )
    r0 = tag_one(client, out, st[0].to_dict())
    assert r0["rotated_deg"] == 180 and r0["tags"] == ["holo", "ctf"] and r0["title"] == "Upside"
    assert np.array_equal(np.asarray(Image.open(out / st[0].file)), np.rot90(before[st[0].file], 2))
    # 90 deg clockwise: image rotated, mm and px swapped, DPI kept
    r1 = tag_one(client, out, st[1].to_dict())
    assert r1["rotated_deg"] == 90 and r1["title"] == "Sideways"
    assert (r1["width_mm"], r1["height_mm"]) == (st[1].height_mm, st[1].width_mm)
    assert np.array_equal(
        np.asarray(Image.open(out / st[1].file)), np.rot90(before[st[1].file], -1)
    )
    assert Image.open(out / st[1].file).info["dpi"][0] == pytest.approx(st[1].dpi, abs=0.1)
    # a bad reply raises and leaves the file untouched
    with pytest.raises(ValueError):
        tag_one(client, out, st[2].to_dict())
    assert np.array_equal(np.asarray(Image.open(out / st[2].file)), before[st[2].file])


def _tilted_sticker(tmp_path, angle):
    """RGBA crop of a 40x20 mm rectangle tilted `angle` deg clockwise, as
    stickersplit writes a non-deskewed die-cut (manifest: deskewed False)."""
    import cv2

    px = 600 / 25.4
    size = int(70 * px)
    a = np.zeros((size, size, 4), np.uint8)
    box = cv2.boxPoints(((size / 2, size / 2), (40 * px, 20 * px), angle)).astype(np.int32)
    cv2.fillPoly(a, [box], (240, 60, 60, 255))
    out = tmp_path / "out"
    out.mkdir()
    Image.fromarray(a, "RGBA").save(out / "s_001.png", dpi=(600, 600))
    bw = int(np.ptp(box[:, 0])) + 1
    bh = int(np.ptp(box[:, 1])) + 1
    rec = {
        "file": "s_001.png",
        "index": 1,
        "deskewed": False,
        "dpi": 600.0,
        "width_px": bw,
        "height_px": bh,
        "width_mm": round(bw / px, 1),
        "height_mm": round(bh / px, 1),
    }
    return out, rec


def test_rotate_png_arbitrary_angle_trims_and_remeasures(tmp_path):
    out, rec = _tilted_sticker(tmp_path, 30)
    r = rotate_png(rec, out / "s_001.png", -30)
    assert r["rotated_deg"] == 330
    assert sorted([r["width_mm"], r["height_mm"]]) == pytest.approx([20, 40], abs=1.0)
    im = Image.open(out / "s_001.png")
    assert im.mode == "RGBA" and im.info["dpi"][0] == pytest.approx(600, abs=0.1)
    assert max(im.size) < 40 * 600 / 25.4 * 1.2  # trimmed, not left on the big canvas


def test_fine_pass_recentres_at_edge(tmp_path):
    out, rec = _tilted_sticker(tmp_path, 25)
    from stickersplit.tag import detail_image

    size = detail_image(Image.open(out / "s_001.png")).size
    # coarse: upright as-is; fine: +40 (edge -> recentre), then -10  => +30 total
    c = FakeClient({size: _reply(upright_panel="A")}, fine=["I", "D"])
    r = tag_one(c, out, rec)
    assert len(c.requests) == 3
    assert r["fine_deg"] == 30 and r["rotated_deg"] == 30


def test_low_confidence_skips_fine_pass(tmp_path):
    out, rec = _tilted_sticker(tmp_path, 25)
    from stickersplit.tag import detail_image

    size = detail_image(Image.open(out / "s_001.png")).size
    c = FakeClient({size: _reply(orientation_confidence="low")}, fine=["I"])
    assert tag_one(c, out, rec)["rotated_deg"] == 0
    assert len(c.requests) == 1


def test_deskewed_stickers_skip_fine_pass(tmp_path):
    out, rec = _tilted_sticker(tmp_path, 0)
    from stickersplit.tag import detail_image

    size = detail_image(Image.open(out / "s_001.png")).size
    c = FakeClient({size: _reply()})
    tag_one(c, out, {**rec, "deskewed": True})
    assert len(c.requests) == 1


def test_refusal_is_retried(tmp_path):
    out, st = _split(tmp_path)
    refusal = SimpleNamespace(stop_reason="refusal", content=[])

    class Flaky(FakeClient):
        def create(self, **req):
            self.requests.append(req)
            return refusal if len(self.requests) == 1 else _reply(title="ok")

    c = Flaky({})
    assert tag_one(c, out, st[0].to_dict())["title"] == "ok"
    assert len(c.requests) == 2


def test_real_sdk_sends_expected_body(tmp_path):
    """Run the real anthropic client against a mocked transport: proves the SDK
    accepts these kwargs and shows what goes over the wire."""
    anthropic = pytest.importorskip("anthropic")
    try:  # anthropic 2.x ships on httpx2; 0.x/1.x on httpx
        import httpx2 as httpx
    except ImportError:
        httpx = pytest.importorskip("httpx")
    out, st = _split(tmp_path)
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        msg = {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "m",
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "upright_panel": "C",
                            "orientation_confidence": "high",
                            "title": "X",
                            "tags": ["a"],
                        }
                    ),
                }
            ],
        }
        return httpx.Response(200, json=msg)

    client = anthropic.Anthropic(
        api_key="test",
        base_url="http://mock",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert tag_one(client, out, st[0].to_dict(), model="claude-sonnet-5-5")["rotated_deg"] == 180
    b = seen["body"]
    assert seen["path"] == "/v1/messages"
    assert b["model"] == "claude-sonnet-5-5"
    assert b["output_config"] == {
        "format": {"type": "json_schema", "schema": SCHEMA},
        "effort": "low",
    }
    assert [c["type"] for c in b["messages"][0]["content"]] == ["image", "image", "text"]
    assert (
        "Tags already used in the collection, most used first: none yet"
        in b["messages"][0]["content"][2]["text"]
    )


def test_prompt_lists_the_collection_vocabulary():
    im = Image.new("RGBA", (50, 50), (255, 0, 0, 255))
    text = build_request(im, "m", "low", ["holo", "defcon-2025"])["messages"][0]["content"][2][
        "text"
    ]
    assert text.endswith("most used first: holo, defcon-2025") and '["holo"]' in text


def test_rotate_image_quarter_turns_are_lossless():
    im = Image.new("RGBA", (30, 10), (0, 0, 0, 0))
    im.putpixel((0, 0), (255, 0, 0, 255))
    r = rotate_image(im, 90)
    assert r.size == (10, 30) and r.getpixel((9, 0)) == (255, 0, 0, 255)  # top-left -> top-right
    assert rotate_image(im, 360) is im


def test_symmetry_finds_tilt_of_symmetric_shape():
    import cv2

    a = np.zeros((400, 400, 4), np.uint8)
    tri = np.array([[200, 60], [80, 330], [320, 330]], np.float32)  # isosceles: mirror-symmetric
    m = cv2.getRotationMatrix2D((200, 200), -12, 1.0)  # tilt 12 deg clockwise
    cv2.fillPoly(a, [cv2.transform(tri[None], m)[0].astype(np.int32)], (200, 50, 50, 255))
    angle, score, score0 = symmetry_angle(Image.fromarray(a, "RGBA"))
    assert angle == pytest.approx(-12, abs=1) and score > score0
