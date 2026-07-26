# Genera la historia de aviso 1080x1920 (worker/public/ig/renovando.png):
# "Estamos renovando el catálogo — repostearemos con mejor estética y
# detalles corregidos". Mismo lenguaje visual que gen-promo-story.py.
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
ARIAL_B = r'C:\Windows\Fonts\arialbd.ttf'
ARIAL = r'C:\Windows\Fonts\arial.ttf'
EMOJI = r'C:\Windows\Fonts\seguiemj.ttf'

ROJO = (220, 38, 38)
AMBAR_TOP, AMBAR_BOT = (252, 211, 77), (234, 179, 8)
BLANCO = (255, 255, 255)
GRIS = (156, 163, 175)

def font(path, size):
    return ImageFont.truetype(path, size)

# ── Fondo: gradiente vertical oscuro ──
img = Image.new('RGB', (W, H), (11, 11, 16))
d = ImageDraw.Draw(img)
TOPC, BOTC = (13, 13, 19), (30, 30, 42)
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=tuple(round(TOPC[i] + (BOTC[i] - TOPC[i]) * t) for i in range(3)))

# ── Bandera a cuadros arriba ──
def checkered(y0, rows=2, size=55):
    for r in range(rows):
        for c in range(0, W // size + 1):
            if (r + c) % 2 == 0:
                d.rectangle([c * size, y0 + r * size, (c + 1) * size - 1, y0 + (r + 1) * size - 1],
                            fill=(235, 235, 235))
checkered(0)

def center_text(y, text, f, fill, tracking=0):
    if tracking:
        tw = sum(d.textlength(ch, font=f) + tracking for ch in text) - tracking
        x = (W - tw) / 2
        for ch in text:
            d.text((x, y), ch, font=f, fill=fill, anchor='lm')
            x += d.textlength(ch, font=f) + tracking
    else:
        d.text((W / 2, y), text, font=f, fill=fill, anchor='mm')

def pill(x0, y0, x1, y1, top, bot, border=None):
    ph = y1 - y0
    grad = Image.new('RGB', (x1 - x0, ph))
    dg = ImageDraw.Draw(grad)
    for yy in range(ph):
        t = yy / ph
        dg.line([(0, yy), (x1 - x0, yy)],
                fill=tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    mask = Image.new('L', (x1 - x0, ph), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, x1 - x0 - 1, ph - 1], radius=ph // 2, fill=255)
    img.paste(grad, (x0, y0), mask)
    if border:
        d.rounded_rectangle([x0, y0, x1 - 1, y1 - 1], radius=ph // 2, outline=border, width=5)

# ── Marca ──
center_text(300, "TOPWHEELS.CL", font(ARIAL_B, 100), ROJO, tracking=6)
d.rectangle([W/2 - 170, 372, W/2 + 170, 378], fill=(60, 60, 74))

# ── Título ──
center_text(500, "ESTAMOS", font(ARIAL_B, 130), BLANCO, tracking=8)
center_text(650, "RENOVANDO", font(ARIAL_B, 150), BLANCO, tracking=6)
center_text(790, "EL CATÁLOGO", font(ARIAL_B, 96), GRIS, tracking=6)

# ── Pill ámbar: EN MANTENIMIENTO / herramienta ──
py0, py1 = 900, 1050
pill(150, py0, W - 150, py1, AMBAR_TOP, AMBAR_BOT, border=BLANCO)
cy = (py0 + py1) // 2
f_pill, f_em = font(ARIAL_B, 62), font(EMOJI, 56)
texto_pill = "MEJORANDO TODO"
GAP = 18
em_w = d.textlength("XX", font=f_em) + GAP
total = em_w + sum(d.textlength(ch, font=f_pill) + 3 for ch in texto_pill) - 3
x = (W - total) / 2
d.text((x, cy + 2), "🔧", font=f_em, anchor='lm', embedded_color=True)
x += em_w
for ch in texto_pill:
    d.text((x, cy + 2), ch, font=f_pill, fill=(17, 17, 17), anchor='lm')
    x += d.textlength(ch, font=f_pill) + 3

# ── Cuerpo del mensaje ──
center_text(1190, "Estamos corrigiendo detalles y", font(ARIAL, 56), BLANCO)
center_text(1270, "repostearemos cada pieza", font(ARIAL, 56), BLANCO)
center_text(1360, "CON MEJOR ESTÉTICA", font(ARIAL_B, 66), (34, 197, 94))

# ── CTA ──
pill(150, 1560, W - 150, 1680, ROJO, (165, 28, 28), border=BLANCO)
f_cta, f_emoji = font(ARIAL_B, 52), font(EMOJI, 48)
cta = "¡VOLVEMOS CON TODO!"
em_w2 = d.textlength("XX", font=f_emoji) + GAP
total2 = em_w2 + d.textlength(cta, font=f_cta)
x0 = (W - total2) / 2
d.text((x0, 1622), "🏁", font=f_emoji, anchor='lm', embedded_color=True)
d.text((x0 + em_w2, 1622), cta, font=f_cta, fill=BLANCO, anchor='lm')

# ── Pie ──
center_text(1800, "Mientras tanto, escríbenos por DM 📩".replace(" 📩", ""), font(ARIAL_B, 46), BLANCO)
d.text((W / 2 + d.textlength("Mientras tanto, escríbenos por DM", font=font(ARIAL_B, 46)) / 2 + 40, 1800),
       "📩", font=font(EMOJI, 44), anchor='mm', embedded_color=True)

out = r'worker\public\ig\renovando.png'
img.save(out, optimize=True)
print('OK', out, img.size)
