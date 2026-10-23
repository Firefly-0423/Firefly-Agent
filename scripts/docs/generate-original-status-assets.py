from array import array
from math import exp, pi, sin
from pathlib import Path
import sys
import wave

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
RATE = 44100


def draw_avatar():
    scale = 4
    image = Image.new("RGBA", (256 * scale, 256 * scale))
    draw = ImageDraw.Draw(image)

    def box(coords):
        return tuple(round(value * scale) for value in coords)

    draw.rounded_rectangle(box((8, 8, 248, 248)), radius=52 * scale,
                           fill="#e5ece7")
    draw.ellipse(box((51, 51, 205, 205)), outline="#c2d1c8", width=10 * scale)
    draw.arc(box((51, 51, 205, 205)), 38, 296, fill="#6f9580", width=10 * scale)
    glow = Image.new("RGBA", image.size)
    ImageDraw.Draw(glow).ellipse(box((134, 48, 192, 106)), fill=(167, 208, 117, 155))
    image = Image.alpha_composite(image, glow.filter(ImageFilter.GaussianBlur(13 * scale)))
    draw = ImageDraw.Draw(image)
    draw.ellipse(box((151, 65, 175, 89)), fill="#f1f7c3")
    draw.ellipse(box((119, 115, 137, 141)), fill="#7e9e89")
    image.resize((256, 256), Image.Resampling.LANCZOS).save(
        ROOT / "examples/system-status/avatar.png")


def write_tone(name, duration, notes):
    samples = [0.0] * round(duration * RATE)
    for start, length, frequency, click in notes:
        count = round(length * RATE)
        offset = round(start * RATE)
        for index in range(count):
            t = index / RATE
            attack = min(1.0, t / 0.012)
            release = min(1.0, (count - 1 - index) / (RATE * 0.065))
            envelope = sin(pi * attack / 2) ** 2 * sin(pi * release / 2) ** 2
            if click:
                envelope *= exp(-t / 0.055)
            # A quiet sine fundamental with a small, softer upper partial.
            tone = sin(2 * pi * frequency * t) + 0.06 * sin(6 * pi * frequency * t)
            samples[offset + index] += 0.18 * envelope * tone
    pcm = array("h", (round(sample * 32767) for sample in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(str(ROOT / f"src/renderer/toast/assets/{name}.wav"), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(RATE)
        audio.writeframes(pcm.tobytes())


if __name__ == "__main__":
    draw_avatar()
    write_tone("toast-action", 0.28, [(0, 0.28, 660, True)])
    write_tone("toast-notify", 0.48, [(0, 0.21, 523.25, False), (0.24, 0.24, 659.25, False)])
