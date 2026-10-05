#!/usr/bin/env python3
"""Generate every TBO Copilot brand image from the Team Back Office mark.

The mark (the folded teal banner with the orange flap) is drawn from vector
geometry measured on the official Team Back Office logo: a 191x80 PNG whose
colours are sampled below. Drawing from geometry keeps every size sharp; the
official PNG is far too small to scale up to a 1024 px icon.

Outputs go to scripts/tbo/assets/, laid out like the repository, and
scripts/tbo/apply-branding.mjs copies them into place:

  apps/desktop/build/icon_1024.png         light app tile (installer master)
  apps/desktop/build/logo_dark.png         dark app tile (installer master)
  apps/desktop/build/icon.png              512 px package icon
  apps/desktop/build/icon.ico              Windows icon, 16-256 px
  apps/desktop/build/icon.icns             macOS icon (needs `iconutil`)
  apps/desktop/build/tray-icon-mac.png     macOS menu bar template
  apps/desktop/build/dmg-background.png    macOS installer window (+ @2x)
  apps/desktop/src/assets/brand/logo-light.png, logo-dark.png
                                           192 px renderer marks (ADR 0125)

It also writes scripts/tbo/brand/tbo-mark.svg, the mark as an SVG.

Requires Pillow. Run: python3 scripts/tbo/make-brand-assets.py
"""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "scripts" / "tbo" / "assets"
BRAND = ROOT / "scripts" / "tbo" / "brand"

# Colours sampled from the official logo.
TEAL_LIGHT = (0x1C, 0x76, 0x90)
TEAL_DARK = (0x14, 0x58, 0x68)
ORANGE = (0xFB, 0x99, 0x1C)
ORANGE_SHADE = (0xC4, 0x6B, 0x0A)

# Geometry in pixels of the 191x80 reference logo.
PANEL_TOP_LEFT = (11.0, 5.8)
PANEL_TOP_RIGHT = (59.0, 18.3)
PANEL_BOTTOM_RIGHT = (59.0, 66.5)
NOTCH = (28.5, 58.0)
TAIL_TIP = (32.5, 79.0)
BACK_BOTTOM_LEFT = (11.0, 53.5)
# The fold between the front (light) and back (dark) panel: a cubic curve
# from the bottom-right corner back up to the top-left corner.
FOLD_CONTROL_1 = (40.0, 62.0)
FOLD_CONTROL_2 = (17.0, 32.0)
FOLD_END = (11.0, 7.0)
FLAP_LEFT = (11.0, 5.2)
FLAP_TOP_RIGHT = (53.0, 1.0)
# The flap's shadow thickens from nothing at the left to this at the right.
FLAP_SHADE_MAX = 6.0

MARK_LEFT, MARK_TOP, MARK_RIGHT, MARK_BOTTOM = 11.0, 1.0, 59.0, 79.0
MARK_WIDTH = MARK_RIGHT - MARK_LEFT
MARK_HEIGHT = MARK_BOTTOM - MARK_TOP

SUPERSAMPLE = 4


def panel_edge_y(x: float) -> float:
    """y of the front panel's top edge (the flap's lower edge) at x."""
    (x0, y0), (x1, y1) = PANEL_TOP_LEFT, PANEL_TOP_RIGHT
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0)


def cubic(p0, p1, p2, p3, steps: int = 96):
    points = []
    for i in range(steps + 1):
        t = i / steps
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t**3
        points.append(
            (
                a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
            )
        )
    return points


def flap_right_bottom() -> tuple[float, float]:
    return (FLAP_TOP_RIGHT[0], panel_edge_y(FLAP_TOP_RIGHT[0]))


def mark_layers():
    """The mark as (colour, polygon) layers, painted in order."""
    outline = [
        PANEL_TOP_LEFT,
        PANEL_TOP_RIGHT,
        PANEL_BOTTOM_RIGHT,
        NOTCH,
        TAIL_TIP,
        BACK_BOTTOM_LEFT,
    ]
    fold = cubic(PANEL_BOTTOM_RIGHT, FOLD_CONTROL_1, FOLD_CONTROL_2, FOLD_END)
    front = [PANEL_TOP_LEFT, PANEL_TOP_RIGHT, *fold]
    flap = [FLAP_LEFT, FLAP_TOP_RIGHT, flap_right_bottom(), PANEL_TOP_LEFT]
    layers = [(TEAL_DARK, outline), (TEAL_LIGHT, front), (ORANGE, flap)]

    # The flap's shadow: bands parallel to the panel edge, from the shade
    # colour at the edge to the flap colour, thickening to the right.
    bands = 24
    right = FLAP_TOP_RIGHT[0]
    for i in range(bands):
        f0, f1 = i / bands, (i + 1) / bands
        t = 1 - (f0 + f1) / 2
        t = t * t * (3 - 2 * t)
        colour = tuple(round(o + (s - o) * t) for o, s in zip(ORANGE, ORANGE_SHADE))
        layers.append(
            (
                colour,
                [
                    PANEL_TOP_LEFT,
                    (right, panel_edge_y(right) - FLAP_SHADE_MAX * f1),
                    (right, panel_edge_y(right) - FLAP_SHADE_MAX * f0),
                ],
            )
        )
    return layers


def draw_mark(height: int, colour_override=None) -> Image.Image:
    """The mark scaled to `height` px, on a transparent background."""
    scale = height / MARK_HEIGHT
    width = math.ceil(MARK_WIDTH * scale)
    ss = SUPERSAMPLE
    big = Image.new("RGBA", (width * ss, height * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(big)
    for colour, polygon in mark_layers():
        fill = colour_override or colour
        draw.polygon(
            [((x - MARK_LEFT) * scale * ss, (y - MARK_TOP) * scale * ss) for x, y in polygon],
            fill=(*fill, 255),
        )
    return big.resize((width, height), Image.LANCZOS)


def vertical_gradient(size, top, bottom) -> Image.Image:
    width, height = size
    image = Image.new("RGBA", size)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y / max(1, height - 1)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line([(0, y), (width, y)], fill=(*colour, 255))
    return image


def app_tile(size: int, dark: bool) -> Image.Image:
    """A macOS-style app icon: rounded tile, soft shadow, mark centred."""
    ss = 2
    big_size = size * ss
    margin = round(big_size * 100 / 1024)
    tile_size = big_size - 2 * margin
    radius = round(tile_size * 0.2245)
    box = (margin, margin, margin + tile_size, margin + tile_size)

    canvas = Image.new("RGBA", (big_size, big_size), (0, 0, 0, 0))

    shadow = Image.new("L", canvas.size, 0)
    offset = round(big_size * 0.012)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (box[0], box[1] + offset, box[2], box[3] + offset), radius, fill=80 if dark else 70
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(big_size * 0.018))
    canvas.paste((0, 0, 0, 255), (0, 0), shadow)

    mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
    if dark:
        fill = vertical_gradient(canvas.size, (0x2C, 0x30, 0x37), (0x15, 0x17, 0x1B))
        border = (255, 255, 255, 26)
    else:
        fill = vertical_gradient(canvas.size, (0xFF, 0xFF, 0xFF), (0xEC, 0xEF, 0xF2))
        border = (0, 0, 0, 22)
    canvas.paste(fill, (0, 0), mask)
    # Drawing on an RGBA image replaces pixels instead of blending, so the
    # translucent border goes on its own layer.
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(overlay).rounded_rectangle(
        box, radius, outline=border, width=max(2, round(big_size / 512))
    )
    canvas.alpha_composite(overlay)

    mark = draw_mark(round(tile_size * 0.6))
    canvas.alpha_composite(
        mark, ((big_size - mark.width) // 2, (big_size - mark.height) // 2)
    )
    return canvas.resize((size, size), Image.LANCZOS)


def tray_template() -> Image.Image:
    """macOS menu bar template: black mark silhouette on transparency.

    A thin gap separates the flap from the panel so the silhouette still
    reads as the mark."""
    mark = draw_mark(768, colour_override=(0, 0, 0))
    scale = 768 / MARK_HEIGHT
    gap = Image.new("L", (mark.width * SUPERSAMPLE, mark.height * SUPERSAMPLE), 255)
    (x0, y0), (x1, y1) = PANEL_TOP_LEFT, PANEL_TOP_RIGHT
    ImageDraw.Draw(gap).line(
        [
            ((x0 - MARK_LEFT) * scale * SUPERSAMPLE, (y0 - MARK_TOP) * scale * SUPERSAMPLE),
            ((x1 - MARK_LEFT) * scale * SUPERSAMPLE, (y1 - MARK_TOP) * scale * SUPERSAMPLE),
        ],
        fill=0,
        width=round(0.9 * scale * SUPERSAMPLE),
    )
    gap = gap.resize(mark.size, Image.LANCZOS)
    alpha = Image.composite(mark.getchannel("A"), Image.new("L", mark.size, 0), gap)
    mark.putalpha(alpha)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    canvas.alpha_composite(mark, ((1024 - mark.width) // 2, 128))
    return canvas


def font(size: int, medium: bool = False):
    path = "/System/Library/Fonts/HelveticaNeue.ttc"
    try:
        return ImageFont.truetype(path, size, index=10 if medium else 0)
    except OSError:
        return ImageFont.load_default(size)


def dmg_background(scale: int) -> Image.Image:
    """The installer window: 720x440 points, icons at (180, 196) and (540, 196)
    as set in apps/desktop/package.json build.dmg.contents."""
    width, height = 720 * scale, 440 * scale
    # An opaque RGB base drawn in "RGBA" mode blends translucent fills.
    image = vertical_gradient((width, height), (0x24, 0x27, 0x2C), (0x16, 0x18, 0x1B)).convert("RGB")

    glow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(glow).ellipse(
        (width * 0.15, height * 0.1, width * 0.85, height * 0.9), fill=26
    )
    glow = glow.filter(ImageFilter.GaussianBlur(60 * scale))
    image.paste((255, 255, 255), (0, 0), glow)

    draw = ImageDraw.Draw(image, "RGBA")
    s = scale

    title_font = font(17 * s, medium=True)
    title = "TBO Copilot"
    mark = draw_mark(26 * s)
    left, top, right, bottom = draw.textbbox((0, 0), title, font=title_font)
    gap = 9 * s
    total = mark.width + gap + (right - left)
    x = (width - total) // 2
    image.paste(mark, (x, 26 * s), mark)
    draw.text((x + mark.width + gap - left, 26 * s + (mark.height - (bottom - top)) // 2 - top),
              title, font=title_font, fill=(255, 255, 255, 235))

    for cx in (180, 540):
        r = 70
        draw.ellipse(
            ((cx - r) * s, (196 - r) * s, (cx + r) * s, (196 + r) * s),
            fill=(255, 255, 255, 9),
            outline=(255, 255, 255, 30),
            width=max(1, s),
        )

    y = 196 * s
    draw.line([(272 * s, y), (440 * s, y)], fill=(255, 255, 255, 190), width=2 * s)
    draw.polygon(
        [(452 * s, y), (438 * s, y - 7 * s), (438 * s, y + 7 * s)],
        fill=(*ORANGE, 255),
    )

    caption_font = font(13 * s)
    caption = "Drag TBO Copilot to Applications to install"
    left, top, right, bottom = draw.textbbox((0, 0), caption, font=caption_font)
    draw.text(((width - (right - left)) // 2 - left, 318 * s), caption,
              font=caption_font, fill=(0xA3, 0xA8, 0xB0, 255))
    return image


def mark_svg() -> str:
    def path(points):
        return "M" + " L".join(f"{x - MARK_LEFT:.2f},{y - MARK_TOP:.2f}" for x, y in points) + " Z"

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MARK_WIDTH:g} {MARK_HEIGHT:g}">',
        "  <title>Team Back Office mark</title>",
        "  <defs>",
        '    <linearGradient id="flap-shade" gradientUnits="userSpaceOnUse"'
        f' x1="{FLAP_TOP_RIGHT[0] - MARK_LEFT:.2f}" y1="{panel_edge_y(FLAP_TOP_RIGHT[0]) - MARK_TOP:.2f}"'
        f' x2="{FLAP_TOP_RIGHT[0] - MARK_LEFT:.2f}" y2="{panel_edge_y(FLAP_TOP_RIGHT[0]) - FLAP_SHADE_MAX - MARK_TOP:.2f}">',
        f'      <stop offset="0" stop-color="#{"%02X%02X%02X" % ORANGE_SHADE}"/>',
        f'      <stop offset="1" stop-color="#{"%02X%02X%02X" % ORANGE}"/>',
        "    </linearGradient>",
        "  </defs>",
    ]
    for colour, polygon in mark_layers()[:3]:
        parts.append(f'  <path fill="#{"%02X%02X%02X" % colour}" d="{path(polygon)}"/>')
    right = FLAP_TOP_RIGHT[0]
    shade = [PANEL_TOP_LEFT, (right, panel_edge_y(right) - FLAP_SHADE_MAX), (right, panel_edge_y(right))]
    parts.append(f'  <path fill="url(#flap-shade)" d="{path(shade)}"/>')
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def save(image: Image.Image, relative: str) -> Path:
    target = ASSETS / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, optimize=True)
    print(f"wrote {target.relative_to(ROOT)}")
    return target


def main() -> None:
    build = "apps/desktop/build"
    light = app_tile(1024, dark=False)
    dark = app_tile(1254, dark=True)
    save(light, f"{build}/icon_1024.png")
    save(dark, f"{build}/logo_dark.png")
    save(light.resize((512, 512), Image.LANCZOS), f"{build}/icon.png")

    ico = ASSETS / build / "icon.ico"
    light.save(ico, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"wrote {ico.relative_to(ROOT)}")

    save(tray_template(), f"{build}/tray-icon-mac.png")
    background = dmg_background(2)
    save(background, f"{build}/dmg-background@2x.png")
    save(background.resize((720, 440), Image.LANCZOS), f"{build}/dmg-background.png")

    brand = "apps/desktop/src/assets/brand"
    save(light.resize((192, 192), Image.LANCZOS), f"{brand}/logo-light.png")
    save(dark.resize((192, 192), Image.LANCZOS), f"{brand}/logo-dark.png")

    BRAND.mkdir(parents=True, exist_ok=True)
    (BRAND / "tbo-mark.svg").write_text(mark_svg())
    print(f"wrote {(BRAND / 'tbo-mark.svg').relative_to(ROOT)}")

    iconutil = shutil.which("iconutil")
    if iconutil is None:
        print("skipped icon.icns (iconutil is only available on macOS)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            light.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            light.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
        icns = ASSETS / build / "icon.icns"
        subprocess.run([iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True)
        print(f"wrote {icns.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
