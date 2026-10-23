"""Compose native transparent Cubism frames on the approved light/dark SVG backgrounds."""
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import argparse
import hashlib
import json

parser = argparse.ArgumentParser()
parser.add_argument("--repo", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
repo, work = args.repo.resolve(), args.out.resolve()
evidence = json.loads((work / "capture-evidence.json").read_text(encoding="utf-8"))
count = evidence["frame_count"]
assert count == 155 and evidence["display_duration_ms"] == 12400
assert not evidence["errors"] and not evidence["blocked"]
assert evidence["runtime"]["physics_loaded"]
assert len({json.dumps(r["transform"], sort_keys=True) for r in evidence["records"]}) == 1
assert all(all(x["opacity"] == 0 for x in r["scene"]) for r in evidence["records"])

paths = [work / "frames" / f"{i:03}.png" for i in range(count + 1)]
bounds = []
for p in paths:
    with Image.open(p) as im:
        assert im.size == (1200, 1200)
        b = im.getchannel("A").getbbox()
        assert b and b[0] > 0 and b[1] > 0 and b[2] < 1200 and b[3] < 1200
        bounds.append(b)
union = (min(b[0] for b in bounds), min(b[1] for b in bounds),
         max(b[2] for b in bounds), max(b[3] for b in bounds))
# The approved SVG reserves x=24,y=6,w=244,h=222 for the character.
# Use one fixed union crop and an aspect-preserving scale for the entire loop.
scale = min(488 / (union[2] - union[0]), 444 / (union[3] - union[1]))
size = (round((union[2] - union[0]) * scale), round((union[3] - union[1]) * scale))
position = (48 + (488 - size[0]) // 2, 12 + (444 - size[1]) // 2)
actors = []
for p in paths:
    with Image.open(p) as im:
        actors.append(im.convert("RGBA").crop(union).resize(size, Image.Resampling.LANCZOS))
assert all(im.getchannel("A").getextrema()[0] == 0 for im in actors)
seam = ImageStat.Stat(ImageChops.difference(actors[0], actors[-1])).mean
records = evidence["records"]
active = [r for r in records if r["applied_parameters"]["Param40"] > 1e-6]
assert active and max(r["applied_parameters"]["Param40"] for r in records) > .99
assert records[0]["applied_parameters"]["Param40"] == records[-1]["applied_parameters"]["Param40"] == 0
assert all(records[-1]["applied_parameters"][p] == 0 for p in
           ["Param", "Param2", "Param3", "Param4", "Param5", "Param8", "Param9", "Param10", "Param11"])
assert max(r["applied_parameters"]["Param"] for r in records) > .99
assert max(r["applied_parameters"]["Param5"] for r in records) > .99
assert max(r["applied_parameters"]["Param8"] for r in records) > .5

report = {
    "native_canvas": [1200, 1200], "native_union_crop": union,
    "actor_size": size, "actor_position": position, "aspect_preserved": True,
    "display_dimensions": [896, 234], "pixel_dimensions": [1792, 468],
    "pixel_density": 2, "duration_ms": 12400, "frame_duration_ms": 80,
    "raw_frames": count, "infinite_loop": True, "fixed_actor_transform": True,
    "transparent_actor": True, "scene_meshes_hidden": True, "model_changed": False,
    "native_motion_and_physics": True, "ai_redraw": False,
    "cat_ear_visible_window": {
        "first_frame": active[0]["frame"], "last_frame": active[-1]["frame"],
        "first_ms": active[0]["display_time_ms"], "last_ms": active[-1]["display_time_ms"],
        "visible_duration_ms": (active[-1]["frame"] - active[0]["frame"] + 1) * 80,
    },
    "next_loop_vs_first_actor_mean_absolute_error_rgba": seam,
    "variants": {},
}
asset_dir = repo / "readme-assets"
for lang in ["zh", "en"]:
    for theme in ["light", "dark"]:
        bg = Image.open(work / f"background-{theme}.{lang}.png").convert("RGBA")
        assert bg.size == (1792, 468)
        expected_bg = (237, 243, 239) if theme == "light" else (12, 20, 23)
        assert bg.getpixel((60, 60))[:3] == expected_bg
        frames = []
        for actor in actors:
            frame = bg.copy()
            frame.alpha_composite(actor, position)
            frames.append(frame.convert("RGB"))
        # A shared palette keeps labels/background stable and retains antialiased
        # actor edges after alpha composition against each theme's own matte.
        sample = Image.new("RGB", (size[0], size[1] * 12))
        indices = [0, 15, 28, 40, 52, 60, 75, 90, 105, 120, 138, 154]
        for row, i in enumerate(indices):
            sample.paste(frames[i].crop((position[0], position[1], position[0] + size[0], position[1] + size[1])), (0, row * size[1]))
        text_palette = bg.convert("RGB").quantize(colors=128, method=Image.Quantize.MEDIANCUT)
        actor_palette = sample.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
        palette = Image.new("P", (1, 1))
        palette.putpalette(text_palette.getpalette()[:384] + actor_palette.getpalette()[:384])
        indexed = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames[:count]]
        # Lock all pixels outside the fixed actor rectangle to the exact same
        # reserved text/background indices. Skin colors cannot tint glyph edges.
        for frame in indexed:
            for box in [(0, 0, 1792, position[1]),
                        (0, position[1], position[0], position[1] + size[1]),
                        (position[0] + size[0], position[1], 1792, position[1] + size[1]),
                        (0, position[1] + size[1], 1792, 468)]:
                frame.paste(text_palette.crop(box), box)
        name = f"firefly-banner-{theme}" + (".en" if lang == "en" else "") + ".gif"
        dest = asset_dir / name
        indexed[0].save(dest, save_all=True, append_images=indexed[1:],
                        duration=80, loop=0, optimize=True, disposal=1)
        total = 0
        text_hashes = set()
        with Image.open(dest) as gif:
            assert gif.size == (1792, 468) and gif.info["loop"] == 0
            for i in range(gif.n_frames):
                gif.seek(i)
                total += gif.info["duration"]
                rgb = gif.convert("RGB")
                text_hashes.add(hashlib.sha256(rgb.crop((556, 0, 1792, 468)).tobytes()).hexdigest())
                # A transparent actor must not introduce a card on either matte.
                assert max(abs(a - b) for a, b in zip(rgb.getpixel((60, 60)), expected_bg)) <= 2
            assert total == 12400 and len(text_hashes) == 1
            gif.seek(0)
            gif.convert("RGB").save(work / f"first-{theme}.{lang}.png")
            gif.seek(50)
            gif.convert("RGB").save(work / f"cat-{theme}.{lang}.png")
            gif.seek(80)
            gif.convert("RGB").save(work / f"glasses-{theme}.{lang}.png")
            gif.seek(130)
            gif.convert("RGB").save(work / f"closed-{theme}.{lang}.png")
            encoded_count = gif.n_frames
        assert dest.stat().st_size < 5 * 1024 * 1024
        quantization_error = ImageStat.Stat(ImageChops.difference(frames[50], indexed[50].convert("RGB"))).mean
        report["variants"][name] = {
            "bytes": dest.stat().st_size, "encoded_frames": encoded_count,
            "duration_ms": total, "text_hash_count": len(text_hashes),
            "quantization_mean_absolute_error_rgb": quantization_error,
            "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
        }
(work / "animation-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
