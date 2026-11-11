#!/usr/bin/env python3
"""Turns raw screenshots into README/site artwork: hero banner, annotated install guide, animated demo GIF."""
import json, math, os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'img')
DOCS = os.path.join(os.path.dirname(__file__), '..', 'docs')
F = '/usr/share/fonts/opentype/inter/'
font = lambda name, size: ImageFont.truetype(F + name, size)
ACCENT = (96, 205, 255)

def rounded(im, r):
    im = im.convert('RGBA')
    m = Image.new('L', im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=r, fill=255)
    im.putalpha(m)
    return im

def with_shadow(im, blur=40, off=(0, 26), alpha=150):
    pad = blur * 3
    canvas = Image.new('RGBA', (im.size[0] + pad * 2, im.size[1] + pad * 2), (0, 0, 0, 0))
    sh = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    sh.paste((0, 0, 0, alpha), (pad + off[0], pad + off[1]), im.split()[3])
    canvas = Image.alpha_composite(canvas, sh.filter(ImageFilter.GaussianBlur(blur)))
    canvas.alpha_composite(im, (pad, pad))
    return canvas, pad

def backdrop(w, h):
    im = Image.new('RGB', (w, h), (8, 8, 11))
    glow = Image.new('RGB', (w, h), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    d.ellipse([-w * .12, -h * .45, w * .42, h * .6], fill=(30, 78, 190))
    d.ellipse([w * .62, -h * .2, w * 1.12, h * .75], fill=(92, 62, 200))
    d.ellipse([w * .32, h * .62, w * .72, h * 1.3], fill=(14, 110, 140))
    glow = glow.filter(ImageFilter.GaussianBlur(w // 9))
    return Image.blend(im, glow, .5)

def hero():
    W, H = 1720, 860
    im = backdrop(W, H).convert('RGBA')
    d = ImageDraw.Draw(im)
    icon = Image.open(os.path.join(DOCS, 'icon-1024.png')).convert('RGBA').resize((132, 132), Image.LANCZOS)
    im.alpha_composite(icon, (110, 150))
    ef = font('Inter-Bold.otf', 26); ex = 268
    for ch in 'AUTO TWITCH DROPS COLLECTOR':
        d.text((ex, 202), ch, font=ef, fill=ACCENT); ex += d.textlength(ch, font=ef) + 4
    d.text((110, 318), 'Dropomat', font=font('InterDisplay-Bold.otf', 128), fill=(255, 255, 255))
    y = 486
    for line in ['Watches Twitch drop streams for you.', 'Queue the games and keep playing.']:
        d.text((114, y), line, font=font('Inter-Medium.otf', 40), fill=(214, 214, 222)); y += 56
    x = 114; y += 26
    pills = Image.new('RGBA', im.size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(pills)
    for label in ['Click to queue', 'Tracks new drops', '12 languages']:
        f = font('Inter-SemiBold.otf', 24)
        w = int(pd.textlength(label, font=f)) + 40
        pd.rounded_rectangle([x, y, x + w, y + 48], radius=24, fill=(255, 255, 255, 22), outline=(255, 255, 255, 60), width=2)
        pd.text((x + 20, y + 10), label, font=f, fill=(205, 238, 255, 255))
        x += w + 12
    im.alpha_composite(pills)
    REAL = os.path.join(os.path.dirname(__file__), 'real')   # real screenshots sent by the author (cropped)
    def place(src, width, angle, pos, pad_in=0):
        s = Image.open(src).convert('RGBA')
        if pad_in:  # crop of a panel: put it on the popup's own background so it reads as a window
            bgc = Image.new('RGBA', (s.size[0] + pad_in * 2, s.size[1] + pad_in * 2), (10, 10, 11, 255))
            bgc.alpha_composite(s, (pad_in, pad_in)); s = bgc
        hh = int(s.size[1] * width / s.size[0])
        s = rounded(s.resize((width, hh), Image.LANCZOS), 22)
        ring = Image.new('RGBA', s.size, (0, 0, 0, 0))
        ImageDraw.Draw(ring).rounded_rectangle([0, 0, s.size[0] - 1, s.size[1] - 1], radius=22, outline=(255, 255, 255, 40), width=2)
        s = Image.alpha_composite(s, ring)
        c, pad = with_shadow(s, 34, (0, 30), 170)
        c = c.rotate(angle, resample=Image.BICUBIC, expand=True)
        im.alpha_composite(c, (pos[0] - pad, pos[1] - pad))
    if os.path.exists(os.path.join(REAL, 'queue.png')):
        place(os.path.join(REAL, 'campaigns.png'), 540, 3, (890, 56), 14)
        place(os.path.join(REAL, 'queue.png'), 560, -2, (1100, 372), 14)
    else:
        place(os.path.join(OUT, 'en', 'campaigns.png'), 430, 4, (880, 96))
        place(os.path.join(OUT, 'en', 'watching.png'), 430, -3, (1230, 150))
    os.makedirs(OUT, exist_ok=True)
    im.convert('RGB').save(os.path.join(OUT, 'hero.png'), optimize=True)

def badge(d, cx, cy, text, r=30):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT, outline=(8, 8, 11), width=5)
    f = font('InterDisplay-Bold.otf', 34)
    w = d.textlength(text, font=f)
    d.text((cx - w / 2, cy - 21), text, font=f, fill=(0, 35, 47))

def install():
    src = os.path.join(RAW, 'extensions.png')
    if not os.path.exists(src):
        return False
    shot = Image.open(src).convert('RGBA')
    rects = json.load(open(os.path.join(RAW, 'extensions.json')))
    k = shot.size[0] / 1100
    d = ImageDraw.Draw(shot)
    def ring(key, num, side):
        r = rects.get(key)
        if not r: return
        x, y, w, h = [v * k for v in r]
        box = [x - 14, y - 12, x + w + 14, y + h + 12]
        for g in range(8, 0, -2):
            d.rounded_rectangle([box[0] - g, box[1] - g, box[2] + g, box[3] + g], radius=18 + g, outline=ACCENT + (40,), width=3)
        d.rounded_rectangle(box, radius=18, outline=ACCENT, width=6)
        if num:  # numer kroku pod ramką, żeby nie zasłaniał napisów obok
            badge(d, (box[0] + box[2]) / 2 if side == 'c' else box[0] + 30, box[3] + 40, num)
    d.rectangle([470 * k, 112 * k, 1096 * k, 160 * k], fill=(255, 255, 255))  # informacja o przeglądarce testowej – zbędna w poradniku
    ring('dev', '2', 'c'); ring('lu', '3', 'l')
    card = rects.get('card')
    if card:
        x, y, w, h = [v * k for v in card]
        d.rounded_rectangle([x - 8, y - 8, x + w + 8, y + h + 8], radius=22, outline=(108, 203, 95), width=6)
    crop_h = int(min(shot.size[1], ((card[1] + card[3] + 40) if card else 420) * k))
    shot = rounded(shot.crop((0, 0, shot.size[0], crop_h)), 28)
    W = shot.size[0] + 240
    bg = backdrop(W, shot.size[1] + 200).convert('RGBA')
    c, pad = with_shadow(shot, 36, (0, 28), 170)
    bg.alpha_composite(c, (120 - pad, 100 - pad))
    bg = bg.convert('RGB').resize((W // 2 * 2 * 3 // 4, (shot.size[1] + 200) * 3 // 4), Image.LANCZOS)
    bg.save(os.path.join(OUT, 'install.png'), optimize=True)
    return True

def gif():
    frames = []
    for i in range(7):
        p = os.path.join(RAW, f'f{i}.png')
        if os.path.exists(p):
            frames.append(Image.open(p).convert('RGB').resize((430, 600), Image.LANCZOS))
    if not frames:
        return
    durations = [1300, 750, 750, 1300, 1500, 1200, 2200][:len(frames)]
    pal = frames[-1].quantize(colors=200, method=Image.MEDIANCUT)
    q = [f.quantize(palette=pal, dither=Image.NONE) for f in frames]
    q[0].save(os.path.join(OUT, 'demo.gif'), save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=True)

hero()
print('install guide:', install())
gif()
for name in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, name)
    if os.path.isfile(p): print(name, os.path.getsize(p) // 1024, 'KB')
